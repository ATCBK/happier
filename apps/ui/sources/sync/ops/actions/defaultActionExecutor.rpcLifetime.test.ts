import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

const boundary = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');

let home: Awaited<ReturnType<typeof boundary.addHome>>;
beforeEach(async () => {
    boundary.resetRequests();
    resetScopedMachineTransportCacheForTests();
    home = await boundary.addHome('https://action-rpc-lifetime.example.test', 'action-owner');
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});
afterAll(() => boundary.dispose());

it.each([
    ['session.stop', RPC_METHODS.STOP_SESSION],
    ['session.runtime.refresh', RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET],
] as const)('retires a signal-free lifecycle Action %s with its Account', async (actionId, method) => {
    boundary.setHttpResponder(async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        return path === '/v2/sessions/session-1'
            ? Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session-1',
                metadata: { path: '/repo', host: 'tester.local', machineId: 'machine-1' } }) }) : null;
    });
    const entered = createDeferred<void>();
    const reply = createDeferred<unknown>();
    boundary.setRpcResponder(async request => {
        expect(request.method).toBe(method);
        entered.resolve();
        return await reply.promise;
    });
    const result = createDefaultActionExecutor().execute(actionId,
        { sessionId: 'session-1', ...(actionId === 'session.runtime.refresh' ? { machineId: 'machine-1' } : {}) },
        { surface: 'ui', authority: 'present_user', serverId: home.id, actionCaller: { kind: 'host' } },
    ).then(value => ({ result: value }), error => ({ error }));
    try {
        expect(await Promise.race([entered.promise.then(() => 'issued'), result])).toBe('issued');
        await boundary.setAccount(home.serverUrl, 'replacement-owner');
        const observation = await Promise.race([result, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 0))]);
        expect(observation).not.toBe('pending');
    } finally { reply.resolve({ status: 'stopped' }); await result; }
});

it.each(['execute', 'prepare'] as const)('retires a signal-free execution-run catalog through %s with its Account', async entrypoint => {
    boundary.setHttpResponder(async input => new URL(String(input)).pathname === '/v2/sessions/session-1'
        ? Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session-1' }) }) : null);
    const entered = createDeferred<void>();
    const reply = createDeferred<unknown>();
    boundary.setRpcResponder(async request => { entered.resolve(); return await reply.promise; });
    const executor = createDefaultActionExecutor();
    const context = { surface: 'ui' as const, serverId: home.id };
    const request = entrypoint === 'execute'
        ? executor.execute('execution.run.list', { sessionId: 'session-1' }, context)
        : executor.prepare('execution.run.list', { sessionId: 'session-1' }, context)
            .then(prepared => prepared.kind === 'ready' ? prepared.invocation.run() : prepared.result);
    const result = request.then(value => ({ result: value }), error => ({ error }));
    try {
        expect(await Promise.race([entered.promise.then(() => 'issued'), result])).toBe('issued');
        await boundary.setAccount(home.serverUrl, 'replacement-owner');
        const observation = await Promise.race([result, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 0))]);
        expect(observation).not.toBe('pending');
    } finally { reply.resolve({ runs: [] }); await result; }
});

it('retires a Sync abort observation with the containing Account lifetime', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { setActiveServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { retireActiveServerAccountScopeLifetime, captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { sync } = await import('@/sync/sync');
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const original = storage.getState();
    await setActiveServer({ serverId: home.id });
    storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
    storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1' }) } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    publishAppliedActiveServerRuntimeAvailability(true);
    captureActiveServerAccountScopeLifetime();
    const connected = createDeferred<void>();
    const stopStatus = apiSocket.onStatusChange(status => { if (status === 'connected') connected.resolve(); });
    apiSocket.initialize({ endpoint: home.serverUrl, serverId: home.id, token: home.token }, null);
    await connected.promise;
    boundary.setHttpResponder(async input => new URL(String(input)).pathname === '/v2/sessions/session-1'
        ? Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session-1' }) }) : null);
    const entered = createDeferred<void>();
    const reply = createDeferred<void>();
    boundary.setRpcResponder(async request => { expect(request.method).toBe('abort'); entered.resolve(); await reply.promise; });
    const result = sync.abortSession('session-1').then(value => ({ result: value }), error => ({ error }));
    try {
        expect(await Promise.race([entered.promise.then(() => 'issued'), result])).toBe('issued');
        retireActiveServerAccountScopeLifetime();
        const observation = await Promise.race([result, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 0))]);
        expect(observation).not.toBe('pending');
        expect(observation).toHaveProperty('error');
        boundary.setRpcResponder(async () => undefined);
        await expect(sync.abortSession('session-1')).resolves.toBeUndefined();
    } finally {
        reply.resolve();
        await result;
        stopStatus();
        apiSocket.disconnect();
        retireActiveServerAccountScopeLifetime();
        publishAppliedActiveServerRuntimeAvailability(false);
        storage.setState(original, true);
    }
});

it.each([
    ['caller', 'execute'], ['account', 'execute'], ['caller', 'prepare'], ['account', 'prepare'],
] as const)('settles a nonreplying Action on %s retirement through %s and permits another request', async (lifetime, entrypoint) => {
    const entered = createDeferred<void>();
    const reply = createDeferred<unknown>();
    boundary.setRpcResponder(async request => {
        expect(request.method).toBe(RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE);
        entered.resolve();
        return await reply.promise;
    });
    const controller = new AbortController();
    const executor = createDefaultActionExecutor();
    const context = {
        surface: 'ui', serverId: home.id, ...(lifetime === 'caller' ? { signal: controller.signal } : {}),
    } as const;
    const request = entrypoint === 'execute'
        ? executor.execute('memory.ensure_up_to_date', { machineId: 'machine-1' }, context)
        : executor.prepare('memory.ensure_up_to_date', { machineId: 'machine-1' }, context)
            .then(prepared => prepared.kind === 'ready' ? prepared.invocation.run() : prepared.result);
    const result = request.then(value => ({ result: value }), error => ({ error }));
    try {
        expect(await Promise.race([entered.promise.then(() => 'issued'), result])).toBe('issued');
        if (lifetime === 'caller') controller.abort();
        else await boundary.setAccount(home.serverUrl, 'replacement-owner');
        // A same-turn checkpoint distinguishes cancellation from the withheld ACK.
        const observation = await Promise.race([result, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 0))]);
        expect(observation).not.toBe('pending');
        expect(observation).toMatchObject({ result: { ok: false, errorCode: expect.any(String) } });
        boundary.setRpcResponder(async () => ({ ok: true }));
        await expect(executor.execute('memory.ensure_up_to_date', { machineId: 'machine-1' }, {
            surface: 'ui', serverId: home.id,
        })).resolves.toMatchObject({ ok: true });
    } finally {
        reply.resolve({ ok: true });
        await result;
    }
});
