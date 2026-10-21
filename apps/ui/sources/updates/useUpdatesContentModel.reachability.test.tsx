import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { UpdatesActionOutputSchemas } from '@happier-dev/protocol/actions/updatesActionFamily';
import { createMachineFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
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
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { useUpdatesContentModel } = await import('./useUpdatesContentModel');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const before = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

afterEach(async () => { standardCleanup(); await connection?.dispose(); connection = undefined;
    storage.setState(before, true); clearMachineRequestReachabilityForTest(); network.resetRequests(); });
afterAll(() => network.dispose());

it('Checks updates explicitly on a request-unreachable machine through the mounted Action owner', async () => {
    const accountHome = await network.addHome('https://updates-retry.test', 'updates-account');
    const serverIdentityId = 'srv_updates_reachability';
    connection = await restoreServerAccountForTest({ serverUrl: accountHome.serverUrl, serverIdentityId, accountId: accountHome.accountId,
        credentials: { token: accountHome.token }, request: async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId } } }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            // The Home's own Machine row is the transport authority the capability read refreshes.
            if (path.startsWith('/v1/machines/')) return Response.json({ machine: createPlainMachineRowFixture({
                id: decodeURIComponent(path.slice('/v1/machines/'.length)), accountId: accountHome.accountId }) });
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
            return null;
        } });
    // The restored Account lifetime names the Home that is actually active.
    const scope = { serverId: connection.serverId, accountId: accountHome.accountId };
    // Match the Plain Machine producer; metadata presence alone is not a content-mode authority.
    const machine = createMachineFixture({ id: 'studio', activeAt: Date.now(), storageMode: 'plain' });
    const machines = [machine,
        createMachineFixture({ id: 'locked', activeAt: Date.now(), availability: { kind: 'locked', reason: 'content_unreadable' } }),
        createMachineFixture({ id: 'revoked', activeAt: Date.now(), revokedAt: Date.now() }),
        createMachineFixture({ id: 'replaced', activeAt: Date.now(), replacedByMachineId: machine.id }),
    ];
    storage.setState(state => ({ profileScope: scope, profile: { ...state.profile, id: scope.accountId },
        machines: Object.fromEntries(machines.map(row => [row.id, row])), machineListByServerId: { [scope.serverId]: machines },
        machineListStatusByServerId: { [scope.serverId]: 'idle' } }));
    recordMachineRequestFailed({ ...scope, serverId: serverIdentityId, machineId: machine.id });
    network.respond(RPC_METHODS.CAPABILITIES_DETECT, { protocolVersion: 1, results: {} });
    const hook = await renderHook(() => useUpdatesContentModel());
    await flushHookEffects();
    expect(network.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)).toHaveLength(0);
    try {
        const execute = createFrontDoorActionExecute();
        await act(async () => {
            const checked = await execute('updates.check', {}, { surface: 'ui', authority: 'present_user',
                serverId: scope.serverId, expectedAccountId: scope.accountId });
            if (!checked.ok) throw new Error(checked.errorCode);
            expect(UpdatesActionOutputSchemas['updates.check'].parse(checked.result)).toEqual({ status: 'requested' });
        });
        await vi.waitFor(() => expect(network.requests.some(request => request.method === RPC_METHODS.CAPABILITIES_DETECT
            && request.targetId === machine.id)).toBe(true));
        expect(network.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)
            .every(request => request.targetId === machine.id)).toBe(true);
    } finally { await hook.unmount(); }
});
