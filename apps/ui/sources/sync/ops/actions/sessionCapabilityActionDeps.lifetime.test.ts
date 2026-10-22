import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SpawnCapabilitiesPreviewOutputV1Schema, SessionCapabilitiesGetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const boundary = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { createUiSessionCapabilityActionDeps } = await import('./sessionCapabilityActionDeps');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes');

let home: Awaited<ReturnType<typeof boundary.addHome>>;
const preview = SpawnCapabilitiesPreviewOutputV1Schema.parse({ ok: true, machinePlatform: 'posix',
    mcp: { strictMode: false, items: [], detected: [] }, skills: { items: [], plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } },
    applyTiming: { mcp: { t: 'session_not_running' }, skills: { t: 'session_not_running' } } });

beforeEach(async () => {
    boundary.resetRequests();
    resetScopedMachineTransportCacheForTests();
    home = await boundary.addHome('https://preview-lifetime.example.test', 'preview-owner');
    boundary.setHttpResponder(async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/sessions/session-1/turns') return Response.json({ v: 1, sessionId: 'session-1', updatedAt: 1, turns: [] });
        return path === '/v2/sessions/session-1' ? Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session-1', metadata: {
            path: '/repo', host: 'fixture', machineId: 'machine-1', flavor: 'codex',
        } }) }) : null;
    });
});
afterEach(async () => {
    vi.useRealTimers();
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});
afterAll(() => boundary.dispose());

it.each(['spawn', 'session'] as const)('keeps the %s preview in its containing Action lifetime beyond the generic RPC cutoff', async kind => {
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    let dispatched = false;
    boundary.setRpcResponder(async request => {
        if (request.method !== RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW) throw new Error('Unexpected Machine operation');
        dispatched = true;
        entered.resolve();
        await released.promise;
        return preview;
    });
    const account = await captureLazyActionAccountContext(home.id);
    const controller = new AbortController();
    const deps = createUiSessionCapabilityActionDeps(account);
    const context = { surface: 'ui' as const, serverId: home.id, signal: controller.signal };
    let settled = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const read = (kind === 'spawn'
        ? deps.spawnCapabilitiesPreview!({ machineId: 'machine-1', agentId: 'codex' }, context)
        : deps.sessionCapabilitiesGet!({ sessionId: 'session-1' }, context)).finally(() => { settled = true; });
    try {
        await vi.waitFor(() => expect(dispatched || settled).toBe(true));
        const phase = await Promise.race([entered.promise.then(() => 'dispatched'), read.then(value => ({ refused: value,
            paths: boundary.httpRequests.map(request => new URL(request.url).pathname) }))]);
        expect(phase).toBe('dispatched');
        await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
        expect(settled).toBe(false);
        released.resolve();
        const result = await read;
        expect(kind === 'spawn' ? SpawnCapabilitiesPreviewOutputV1Schema.parse(result) : SessionCapabilitiesGetOutputV1Schema.parse(result))
            .toMatchObject({ ok: true });
    } finally {
        released.resolve();
        await read;
        account.dispose();
    }
});

it('returns a typed preview timeout for a reachable Session instead of claiming the Session is unavailable', async () => {
    boundary.setRpcAckResponder(async () => ({ ok: false, error: 'Deadline exceeded', errorCode: 'RPC_REQUEST_TIMEOUT' }));
    const account = await captureLazyActionAccountContext(home.id);
    try {
        const result = await createUiSessionCapabilityActionDeps(account).sessionCapabilitiesGet!({ sessionId: 'session-1' }, { surface: 'ui', serverId: home.id });
        expect(result).toEqual({ ok: false, code: 'preview_timeout' });
        expect(SessionCapabilitiesGetOutputV1Schema.parse(result)).toEqual(result);
    } finally { account.dispose(); }
});
