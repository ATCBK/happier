import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useManagedMachineAccountSettings } = await import('./useManagedMachineAccountSettings');
beforeEach(async () => { await harness.reset(); });
afterEach(() => standardCleanup());

describe('managed creation preferences on the addressed Account', () => {
    it('reads the saved Home rather than the focused Home and withdraws its preferences when custody retires', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner' });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        const settings = { managedMachineCreationEnabled: false, machineRetentionDefaultsV1: { v: 1, local: {
            retention: { kind: 'unused', afterMs: 17_500, effect: 'stop' }, wakeOnAcceptedMessage: true,
        } } };
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        const hook = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(target);
            return { binding: binding?.scope, preferences: useManagedMachineAccountSettings(binding, resolution) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toMatchObject({ accountId: 'owner' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.loading).toBe(false));
        expect(hook.getCurrent().preferences).toMatchObject({ settings, loading: false, error: null });
        expect(harness.requestsFor('/v2/account/settings').every(request => request.serverId === target)).toBe(true);
        const savedPreferences = hook.getCurrent().preferences.settings;
        const settingsReads = harness.requestsFor('/v2/account/settings').length;
        for (const kind of ['session', 'machine'] as const) {
            await act(async () => publishHomeAccountChange(target, ['unrelated-row'], { changeKinds: [kind] }));
            await flushHookEffects();
        }
        await act(async () => publishHomeAccountChange(target, ['workflow-run:unrelated'], {
            changeKinds: ['account'], accountSettingsAffects: false,
        }));
        await flushHookEffects();
        expect(harness.requestsFor('/v2/account/settings')).toHaveLength(settingsReads);
        await act(async () => publishHomeAccountChange(target, ['approval-artifact'], { changeKinds: ['artifact'] }));
        await flushHookEffects();
        expect(hook.getCurrent().preferences.settings).toBe(savedPreferences);
        expect(harness.requestsFor('/v2/account/settings')).toHaveLength(settingsReads);
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { ...settings, managedMachineCreationEnabled: true } }, version: 2 } });
        await act(async () => publishHomeAccountChange(target, ['self'], { changeKinds: ['artifact', 'account'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(true));
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 3 } });
        await act(async () => publishHomeAccountChange(target));
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(false));
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { ...settings, managedMachineCreationEnabled: true } }, version: 4 } });
        await act(async () => publishHomeAccountChange(target, ['new-domain'], { changeKinds: ['artifact', 'future.domain'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(true));
        harness.answer(target, '/v2/account/settings', { status: 403, body: { error: 'permission_denied' } });
        await act(async () => { await harness.switchAccount(target, 'replacement'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings).toBeNull());
        await hook.unmount();
    });

    it('keeps the binding and preferences when an unrelated Home profile changes', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner' });
        const settings = { managedMachineCreationEnabled: true, machineRetentionDefaultsV1: undefined };
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        // Every render of the consumer, so a one-frame withdrawal cannot slip between polls.
        const enabledByRender: boolean[] = [];
        const hook = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(target);
            const preferences = useManagedMachineAccountSettings(binding, resolution);
            enabledByRender.push(preferences.settings?.managedMachineCreationEnabled === true);
            return { binding, preferences };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().preferences.settings?.managedMachineCreationEnabled).toBe(true));
        const firstBinding = hook.getCurrent().binding;
        const firstEnabled = enabledByRender.indexOf(true);
        const reads = harness.requestsFor('/v2/account/settings').length;
        // Only the exact Home URL/credentials affect this binding, not a sibling profile.
        await act(async () => { await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' }); });
        await flushHookEffects();
        expect(hook.getCurrent().binding).toBe(firstBinding);
        expect(harness.requestsFor('/v2/account/settings')).toHaveLength(reads);
        expect(enabledByRender.slice(firstEnabled).every(Boolean)).toBe(true);
        await hook.unmount();
    });
});
