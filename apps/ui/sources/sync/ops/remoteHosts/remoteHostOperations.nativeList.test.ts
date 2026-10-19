import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual<typeof import('@/text')>('@/text') });
// Use the canonical boundary for Metro's deferred module loader.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Initialize the real store after installing its external boundaries, before
// importing the Account Action graph (the same order as the desktop harness).
await import('@/sync/domains/state/storage');
const [{ createUiRemoteHostActionExecuteV1 }, { captureLazyActionAccountContext }] = await Promise.all([
    import('./remoteHostOperations'), import('@/sync/ops/actions/actionAccountContext'),
]);

afterEach(async () => { await standardCleanup(); vi.unstubAllEnvs(); await home.reset(); });

// The production runner selects its platform once per process. Keep native
// source validation in its own isolated test module, as on an actual device.
it('reads native lease inventory through the same Action without requiring a desktop task bridge', async () => {
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'native');
    const serverId = await home.addHome({ name: 'Native inventory', serverUrl: 'https://native-inventory.test', accountId: 'owner' });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            remoteHostActionExecute: createUiRemoteHostActionExecuteV1(account),
        }));
        const result = await executor.execute('remote_hosts.tunnel.list', {}, { surface: 'agent', authority: 'account_automation',
            serverId, bypassApprovals: true });
        expect(result, !result.ok ? result.errorCode : undefined).toMatchObject({ ok: true, result: { status: 'listed',
            native: { leases: [], platformLimitations: expect.arrayContaining([expect.objectContaining({ reason: 'foreground-only' })]) } } });
    } finally { account.dispose(); }
});
