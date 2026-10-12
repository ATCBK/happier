import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const boundary = await installSessionOpsNetworkBoundary();
const { callGuardedMachineRpcWithPolicy } = await import('./guardedMachineRpc');
const { serverScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('./serverScopedRpcPool');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
let home: Awaited<ReturnType<typeof boundary.addHome>>;

beforeEach(async () => {
    boundary.resetRequests();
    resetScopedMachineTransportCacheForTests();
    resetServerFeaturesClientForTests();
    home = await boundary.addHome('https://guarded-home.example.test', 'guarded-account');
    boundary.respond(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, { ok: true });
});
afterEach(async () => {
    vi.useRealTimers();
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});
afterAll(() => boundary.dispose());

it.each(['deadline', 'cancellation'] as const)('settles %s during policy preparation without dispatching', async (settlement) => {
    const observed = createDeferred<void>();
    const response = createDeferred<void>();
    boundary.setHttpResponder(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path !== '/v1/features') return null;
        observed.resolve();
        await response.promise;
        return Response.json(createRootLayoutFeaturesResponse({ features: { machines: { transfer: {
            enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true },
        } } } }));
    });
    const controller = new AbortController();
    vi.useFakeTimers();
    let outcome: unknown;
    const pending = callGuardedMachineRpcWithPolicy({ serverId: home.id, machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, payload: {}, timeoutMs: 100,
        signal: controller.signal }).catch((error: unknown) => { outcome = error; });
    try {
        await observed.promise;
        if (settlement === 'cancellation') controller.abort();
        await vi.advanceTimersByTimeAsync(100);
        expect(outcome).toMatchObject({ code: settlement === 'deadline' ? 'MACHINE_RPC_TIMEOUT' : 'MACHINE_RPC_ABORTED' });
        expect(boundary.requests).toHaveLength(0);
    } finally {
        response.resolve();
        await pending;
    }
});
