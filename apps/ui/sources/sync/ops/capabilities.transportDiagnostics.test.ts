import { afterEach, expect, it, vi } from 'vitest';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let dialing = false;
installDisconnectedServerSocketBoundary(socket => {
    if (typeof socket.auth === 'object' && socket.auth.clientPurpose === 'scoped-rpc') {
        socket.connected = false;
        socket.connect = vi.fn(() => { dialing = true; return socket; });
    } else {
        configureConnectedServerSocketBoundary(socket);
    }
});
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

afterEach(async () => {
    vi.useRealTimers();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await connection?.dispose();
    await homes.reset();
    vi.restoreAllMocks();
});

it('retains content-free pool timeout diagnostics through the real scoped Machine RPC and Describe consumer', async () => {
    await homes.addHome({ name: 'Active', serverUrl: 'https://active-describe.test', accountId: 'active-account' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://active-describe.test', accountId: 'active-account', request: homes.request });
    const target = await homes.addHome({ name: 'Target', serverUrl: 'https://target-describe.test', accountId: 'target-account', active: false });
    homes.answer(target, '/v1/machines/machine-1', { body: { machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'target-account' }) } });
    installHomeGovernanceBoundaries(homes);
    const { machineCapabilitiesDescribe } = await import('./capabilities');
    vi.useFakeTimers();
    const pending = machineCapabilitiesDescribe('machine-1', { serverId: target });
    await vi.waitFor(() => expect(dialing).toBe(true));
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result).toEqual({ supported: false, reason: 'error', error: {
        name: 'Error', rpcErrorCode: 'MACHINE_RPC_TIMEOUT', connectionPhase: 'socket-connect',
    } });
});
