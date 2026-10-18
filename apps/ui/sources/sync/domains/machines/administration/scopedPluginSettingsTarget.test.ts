import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary, type SessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { removeServerProfile, setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { storage } from '@/sync/domains/state/storageStore';

import { useScopedPluginSettingsDaemonTargetBinding } from './scopedPluginSettingsTarget';

// Transport is the boundary; Account qualification and target currentness stay real.
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

let network: SessionOpsNetworkBoundary;
beforeEach(async () => { network = await installSessionOpsNetworkBoundary(); });
afterEach(async () => {
    standardCleanup();
    await network.dispose();
    publishAppliedActiveServerRuntimeAvailability(false);
});

describe('useScopedPluginSettingsDaemonTargetBinding', () => {
    it('retains stable targets across unrelated edits but rejects daemon and local selection changes', async () => {
        const previous = storage.getState();
        const serverUrl = 'https://administration-plugin-binding.example.test';
        await upsertServerProfile({ serverUrl, name: 'Plugin binding' });
        const profile = await setServerProfileIdentityForUrl(serverUrl, 'srv_plugin_binding');
        if (!profile?.serverIdentityId) throw new Error('Test profile was not created');
        const scope = { serverId: profile.id, accountId: 'plugin-binding-account' };
        await network.addHome(serverUrl, scope.accountId);
        await setActiveServerId(profile.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const targetA = { serverIdentityId: profile.serverIdentityId, machineId: 'machine-a' };
        const targetB = { serverIdentityId: profile.serverIdentityId, machineId: 'machine-b' };
        const machineA = createMachineFixture({ id: targetA.machineId, activeAt: Date.now(), daemonStateVersion: 1 });
        const machineB = createMachineFixture({ id: targetB.machineId, activeAt: Date.now(), daemonStateVersion: 1 });
        try {
            storage.setState((state) => ({
                isDataReady: true,
                profileScope: scope,
                settingsScope: scope,
                machineListByServerId: { [profile.id]: [machineA, machineB] },
                machineListStatusByServerId: { [profile.id]: 'idle' },
                settings: { ...state.settings, machineAdministrationTargetsLocalV1: { 'plugins.home': targetA } },
            }));
            const hook = await renderHook(() => useScopedPluginSettingsDaemonTargetBinding('plugins.home', {
                allowSoleCandidate: false,
            }));
            const original = hook.getCurrent();
            expect(original.executionTarget?.machine.id).toBe('machine-a');
            expect(original.target?.machineId).toBe('machine-a');
            if (!original.target || !original.executionTarget) throw new Error('Target did not resolve');

            await act(async () => {
                storage.setState((state) => ({ settings: { ...state.settings, analyticsOptOut: !state.settings.analyticsOptOut } }));
            });
            await hook.rerender();
            expect(hook.getCurrent().executionTarget).toBe(original.executionTarget);
            expect(hook.getCurrent().target).toBe(original.target);
            expect(hook.getCurrent().isTargetCurrent).toBe(original.isTargetCurrent);
            expect(hook.getCurrent().resolveCurrentExecutionTarget).toBe(original.resolveCurrentExecutionTarget);

            await act(async () => {
                storage.setState({ machineListByServerId: { [profile.id]: [{ ...machineA, daemonStateVersion: 2 }, machineB] } });
            });
            const updated = hook.getCurrent();
            expect(updated.executionTarget).not.toBe(original.executionTarget);
            expect(original.isTargetCurrent(original.target)).toBe(false);
            expect(updated.resolveCurrentExecutionTarget(original.executionTarget)).toBeNull();
            if (!updated.executionTarget || !updated.target) throw new Error('Updated target did not resolve');
            expect(updated.isTargetCurrent(updated.target)).toBe(true);

            for (const target of [targetB, targetA]) {
                await act(async () => {
                    storage.setState((state) => ({ settings: {
                        ...state.settings, machineAdministrationTargetsLocalV1: { 'plugins.home': target },
                    } }));
                });
            }
            expect(hook.getCurrent().executionTarget).not.toBe(updated.executionTarget);
            expect(hook.getCurrent().executionTarget?.machine.id).toBe('machine-a');
            expect(updated.isTargetCurrent(updated.target)).toBe(false);
            await hook.unmount();
        } finally {
            storage.setState(previous);
            await removeServerProfile(profile.id);
        }
    });
});
