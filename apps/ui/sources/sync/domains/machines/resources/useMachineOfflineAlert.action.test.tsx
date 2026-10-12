import { afterEach, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

installDisconnectedServerSocketBoundary();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { useMachineOfflineAlert } = await import('./useMachineOfflineAlert');
const before = storage.getState();
afterEach(async () => { standardCleanup(); storage.setState(before); await home.reset(); });

it('persists keyed offline consent through the real Account Action, preserving other machines', async () => {
    const serverId = await home.addHome({ name: 'Offline', serverUrl: 'https://offline.test', serverIdentityId: 'srv_offline', accountId: 'owner', currentAccount: true });
    let raw: Record<string, unknown> = { machineOfflineAlertsV1: { machineIds: ['peer'] } };
    let version = 1;
    home.answer(serverId, '/v2/account/settings', { select(input) {
        if (input === undefined || input === null) return { body: { content: { t: 'plain', v: raw }, version } };
        const write = AccountSettingsV2UpdateRequestSchema.parse(input);
        expect(write.expectedVersion).toBe(version);
        if (write.content?.t !== 'plain') throw new Error('Expected plain Account settings');
        raw = write.content.v;
        version += 1;
        return { body: { success: true, version } };
    } });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    storage.setState({ settingsScope: scope, profileScope: scope, settings: settingsParse(raw) });
    // Collect the actual Action ingress too, so an unavailable native boundary cannot be hidden by the hook's failure result.
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    expect(await createDefaultActionExecutor().execute('settings.get', { anchor: 'notifications.machineOffline', key: 'machine' },
        { surface: 'ui', serverId: scope.serverId, expectedAccountId: 'owner' })).toMatchObject({ ok: true, result: { value: false } });
    const hook = await renderHook(() => useMachineOfflineAlert({ serverId, machineId: 'machine' }));
    let saved: Awaited<ReturnType<ReturnType<typeof useMachineOfflineAlert>['set']>> | undefined;
    await act(async () => { saved = await hook.getCurrent().set(true); });
    expect(saved, JSON.stringify({ saved, paths: home.requests.map(request => request.path) })).toMatchObject({ saved: true, enabled: true });
    expect(raw.machineOfflineAlertsV1).toEqual({ machineIds: ['peer', 'machine'] });
    await act(async () => { saved = await hook.getCurrent().set(false); });
    expect(saved).toMatchObject({ saved: true, enabled: false });
    expect(raw.machineOfflineAlertsV1).toEqual({ machineIds: ['peer'] });
    home.answer(serverId, 'POST /v2/account/settings', { status: 403, body: { error: 'forbidden' } });
    await act(async () => { saved = await hook.getCurrent().set(true); });
    expect(saved).toMatchObject({ saved: false, enabled: false });
    expect(raw.machineOfflineAlertsV1).toEqual({ machineIds: ['peer'] });
    await hook.unmount();
});
