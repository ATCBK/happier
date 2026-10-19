import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// Keep the hook, retention store, status adapters and Socket RPC cancellation real.
const boundary = await installSessionOpsNetworkBoundary();
const { socketRpcCodec } = await import('@happier-dev/sync-client');
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { sessionRunnerRuntimeStatusRetention } = await import('@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatusRetention');
const { useSessionRunnerRuntimeStatusRetention } = await import('./useSessionRunnerRuntimeStatusRetention');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
let home: Awaited<ReturnType<typeof boundary.addHome>>;
let pending = true;

beforeEach(async () => {
    boundary.resetRequests();
    resetScopedMachineTransportCacheForTests();
    sessionRunnerRuntimeStatusRetention.clearForTests();
    home = await boundary.addHome('https://runtime-status.test', 'account-a');
    pending = true;
    boundary.setRpcResponder(async request => {
        expect(request.method).toBe(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET);
        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload,
            `${request.targetId}:${request.method}`);
        if (!decoded.params || typeof decoded.params !== 'object' || !('sessionId' in decoded.params)) {
            throw new Error('Expected runtime status Session identity');
        }
        if (pending) await new Promise(() => {});
        return await socketRpcCodec.encodeResponse({ mode: 'plain' }, {
            v: 2,
            state: {
                v: 1, sessionId: decoded.params.sessionId, machineId: 'machine-one',
                daemonId: 'daemon-one', observedAtMs: 1,
                runner: { pid: 123, runtimeId: 'runtime-one', cliVersion: '1', entrypointVersion: 'entry-one',
                    processCommandHash: 'hash-one', entrypointSource: 'process_command', startedBy: 'daemon', startingMode: 'remote' },
                daemon: { cliVersion: '1', startedWithCliVersion: '1', currentEntrypointVersion: 'entry-one', currentEntrypointSource: 'packaged_runtime' },
                versionState: 'current', statusSource: 'daemon_tracking',
                plannedRestart: { supported: true, eligible: true, disabledReason: null },
            },
            runnerProcessIdentity: { pid: 123, processStartTimeMs: 1 },
        }, decoded.callId);
    });
});
afterEach(async () => {
    standardCleanup();
    await serverScopedRpcSocketPool.stopAll();
    sessionRunnerRuntimeStatusRetention.clearForTests();
});
afterAll(() => boundary.dispose());

function cancellations() {
    return boundary.socketBoundaries.flatMap(item => item.socket.emit.mock.calls)
        .filter(([event]) => event === SOCKET_RPC_EVENTS.CANCEL);
}

it('cancels unanswered runtime status when hidden and retries on return, refresh supersession and target navigation', async () => {
    const hook = await renderHook((input: { enabled: boolean; sessionId: string }) => useSessionRunnerRuntimeStatusRetention({
        ...input, serverId: home.id, machineId: 'machine-one',
    }), { initialProps: { enabled: true, sessionId: 'session-one' } });
    await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
    await hook.rerender({ enabled: false, sessionId: 'session-one' });
    expect(cancellations()).toHaveLength(1);
    expect(hook.getCurrent().status).toBeNull();

    pending = false;
    await hook.rerender({ enabled: true, sessionId: 'session-one' });
    await vi.waitFor(() => expect(hook.getCurrent().status?.state.sessionId).toBe('session-one'));

    pending = true;
    await act(async () => hook.getCurrent().invalidateAndRefresh());
    await vi.waitFor(() => expect(boundary.requests).toHaveLength(3));
    await act(async () => hook.getCurrent().invalidateAndRefresh());
    await vi.waitFor(() => expect(boundary.requests).toHaveLength(4));
    expect(cancellations()).toHaveLength(2);

    pending = false;
    await hook.rerender({ enabled: true, sessionId: 'session-two' });
    expect(cancellations()).toHaveLength(3);
    await vi.waitFor(() => expect(hook.getCurrent().status?.state.sessionId).toBe('session-two'));

    pending = true;
    await act(async () => hook.getCurrent().invalidateAndRefresh());
    await vi.waitFor(() => expect(boundary.requests).toHaveLength(6));
    await hook.unmount();
    expect(cancellations()).toHaveLength(4);
});

it('cancels the retained observation when its original Account retires', async () => {
    const account = await captureLazyActionAccountContext(home.id);
    try {
        const hook = await renderHook(() => useSessionRunnerRuntimeStatusRetention({
            enabled: true, serverId: home.id, sessionId: 'session-one', machineId: 'machine-one',
            accountLifetime: account.accountLifetime,
        }));
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
        await boundary.setAccount(home.serverUrl, 'account-b');
        expect(cancellations()).toHaveLength(1);
        expect(hook.getCurrent().status).toBeNull();
        await hook.unmount();
    } finally {
        account.dispose();
    }
});
