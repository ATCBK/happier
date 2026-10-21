import { afterEach, expect, it, onTestFailed, vi } from 'vitest';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let dialing = false;
installDisconnectedServerSocketBoundary(socket => {
    if (typeof socket.auth === 'object' && socket.auth.clientPurpose === 'scoped-rpc') {
        socket.connected = false;
        socket.connect = vi.fn(() => { dialing = true; return socket; });
    } else configureConnectedServerSocketBoundary(socket);
});
const { dispatchSessionSpawnNewToMachine } = await import('./sessionSpawnNewAction');

afterEach(async () => {
    vi.useRealTimers();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await homes.reset();
    vi.restoreAllMocks();
    dialing = false;
});

it('retains the real pool phase through spawn dispatch and the strict result consumer for an external Agent', async () => {
    let phase = 'Home setup';
    onTestFailed(() => { console.error('Spawn diagnostic seam stopped at', phase); });
    await homes.addHome({ name: 'Active', serverUrl: 'https://active-spawn.test', accountId: 'active-account' });
    const target = await homes.addHome({ name: 'Target', serverUrl: 'https://target-spawn.test', accountId: 'target-account', active: false });
    homes.answer(target, '/v1/machines/machine-1', { body: { machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'target-account' }) } });
    installHomeGovernanceBoundaries(homes);
    const payload = SessionSpawnNewInputV2Schema.parse({ creationKey: 'external-agent-attempt',
        executionTarget: { serverId: target, machineId: 'machine-1' }, directory: { kind: 'managed' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'fixture.external-agent', localId: 'agent' } },
    });
    phase = 'scoped socket acquisition';
    vi.useFakeTimers();
    const pending = dispatchSessionSpawnNewToMachine({ payload });
    await vi.waitFor(() => expect(dialing).toBe(true));
    phase = 'pool deadline';
    await vi.advanceTimersByTimeAsync(readSpawnSessionRpcTimeoutMsFromEnv());
    phase = 'spawn settlement';
    const result = await pending;
    expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', retryable: true,
        launchError: { code: 'MACHINE_RPC_TIMEOUT', rpcErrorCode: 'MACHINE_RPC_TIMEOUT', connectionPhase: 'socket-connect' } });
    expect(SessionSpawnNewResultV1Schema.parse(result)).toEqual(result);
});
