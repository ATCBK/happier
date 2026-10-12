import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createMachineFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Native OTA and desktop event listeners are genuine platform boundaries.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('expo-updates', () => ({
    useUpdates: () => ({ currentlyRunning: { isEmbeddedLaunch: true }, isChecking: false,
        isDownloading: false, isRestarting: false, isUpdateAvailable: false, isUpdatePending: false }),
    checkForUpdateAsync: async () => ({ isAvailable: false }),
}));

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUpdatesAction } = await import('./updatesActionRuntime');
const { useUpdatesContentModel } = await import('./useUpdatesContentModel');
const before = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

afterEach(async () => { standardCleanup(); await connection?.dispose(); connection = undefined;
    storage.setState(before, true); clearMachineRequestReachabilityForTest(); network.resetRequests(); });
afterAll(() => network.dispose());

it('Checks updates explicitly on a request-unreachable machine through the mounted Action owner', async () => {
    const accountHome = await network.addHome('https://updates-retry.test', 'updates-account');
    const home = await adoptHomeProfile({ descriptor: { serverUrl: accountHome.serverUrl, homeServerIdentityId: 'srv_updates_reachability' }, source: 'manual' });
    connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId: accountHome.accountId,
        credentials: { token: accountHome.token }, request: async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
            return null;
        } });
    const scope = { serverId: home.id, accountId: accountHome.accountId };
    // Match the Plain Machine producer; metadata presence alone is not a content-mode authority.
    const machine = createMachineFixture({ id: 'studio', activeAt: Date.now(), storageMode: 'plain' });
    const machines = [machine,
        createMachineFixture({ id: 'locked', activeAt: Date.now(), availability: { kind: 'locked', reason: 'content_unreadable' } }),
        createMachineFixture({ id: 'revoked', activeAt: Date.now(), revokedAt: Date.now() }),
        createMachineFixture({ id: 'replaced', activeAt: Date.now(), replacedByMachineId: machine.id }),
    ];
    storage.setState(state => ({ profileScope: scope, profile: { ...state.profile, id: scope.accountId },
        machines: Object.fromEntries(machines.map(row => [row.id, row])), machineListByServerId: { [home.id]: machines },
        machineListStatusByServerId: { [home.id]: 'idle' } }));
    recordMachineRequestFailed({ ...scope, serverId: home.serverIdentityId!, machineId: machine.id });
    network.respond(RPC_METHODS.CAPABILITIES_DETECT, { protocolVersion: 1, results: {} });
    const hook = await renderHook(() => useUpdatesContentModel());
    await flushHookEffects();
    expect(network.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)).toHaveLength(0);
    const account = await captureLazyActionAccountContext(home.id);
    try {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ updatesAction: createUpdatesAction(account) }));
        await act(async () => { expect(await executor.execute('updates.check', {}, { surface: 'ui', authority: 'present_user' })).toEqual({ ok: true, result: { status: 'requested' } }); });
        await vi.waitFor(() => expect(network.requests.some(request => request.method === RPC_METHODS.CAPABILITIES_DETECT
            && request.targetId === machine.id)).toBe(true));
        expect(network.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)
            .every(request => request.targetId === machine.id)).toBe(true);
    } finally { account.dispose(); await hook.unmount(); }
});
