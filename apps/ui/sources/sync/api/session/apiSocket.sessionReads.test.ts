import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createDeferred } from '@/dev/testkit';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createCapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { readSessionByIdHttp, resetSessionByIdHttpReadsForTests } from '@/sync/engine/sessions/sessionByIdHttp';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { apiSocket } from './apiSocket';

installTokenStorageWebPlatformMocks();
vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: () => createSocketIoBoundaryStub().socket };
});

const oldToken = `e30.${Buffer.from(JSON.stringify({ sub: 'session-account' })).toString('base64url')}.signature`;
const newToken = oldToken.replace(/signature$/, 'renewed-signature');
const endpoint = 'https://session-recovery.example.test';
let storage: ReturnType<typeof installLocalStorageMock>;
let locks: ReturnType<typeof installWebLockManagerMock>;

beforeEach(async () => {
    storage = installLocalStorageMock();
    locks = installWebLockManagerMock();
    setRuntimeFetch(async () => Response.json({}));
    await upsertAndActivateServer({ serverUrl: endpoint, name: 'Session recovery' });
    await TokenStorage.setCredentials({ token: oldToken });
});
afterEach(async () => {
    apiSocket.disconnect();
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    resetSessionByIdHttpReadsForTests();
    resetRuntimeFetch();
    locks.restore();
    storage.restore();
    vi.restoreAllMocks();
});

function prepare() {
    const snapshot = getActiveServerSnapshot();
    const target = { endpoint, serverId: snapshot.serverId, generation: snapshot.generation };
    apiSocket.initialize({ ...target, token: oldToken, credentials: { token: oldToken } }, null);
    const request = apiSocket.createRequestForPreparedTarget(target);
    return { target, request, readTransport: createCapturedServerReadTransport({ serverId: target.serverId,
        credentials: { token: oldToken }, prepared: { endpointUrl: endpoint, generation: target.generation, request } }) };
}

function parts(init?: RequestInit) {
    const demand = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
    return Response.json({ results: demand.sessionIds.map(sessionId => ({ sessionId,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) } },
        ...(demand.includeTurns !== false ? { turns: { status: 200, body: { v: 1, sessionId, updatedAt: 1, turns: [] } } } : {}),
    })) });
}

it.each(['GET', 'POST'] as const)('recovers a prepared Session %s read once after a 401 and retains the replacement bearer without user interaction', async method => {
    const authorizations: Array<string | null> = [];
    const path = method === 'GET' ? '/v2/sessions/session' : '/v2/sessions/read-batch';
    setRuntimeFetch(async (input, init) => {
        if (new URL(String(input)).pathname !== path) return Response.json({});
        authorizations.push(new Headers(init?.headers).get('Authorization'));
        if (authorizations.length === 1) {
            await TokenStorage.setCredentials({ token: newToken });
            return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        return method === 'GET' ? Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session' }) }) : parts(init);
    });
    const binding = prepare();
    if (method === 'GET') {
        await expect(binding.request(path, { method }, { retry: 'none' }, async (response): Promise<unknown> => await response.json()))
            .resolves.toMatchObject({ session: { id: 'session' } });
    } else {
        await expect(readSessionByIdHttp({ ...binding, sessionId: 'session', token: oldToken, retry: 'none' }))
            .resolves.toMatchObject({ ok: true, body: { session: { id: 'session' } } });
    }
    expect(authorizations).toEqual([`Bearer ${oldToken}`, `Bearer ${newToken}`]);
    expect(await TokenStorage.getCredentials()).toEqual({ token: newToken });
    await expect(apiSocket.request(path, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['session'], includeSnapshot: true, includeTurns: false }) } : {}) }, { retry: 'none' }))
        .resolves.toHaveProperty('status', 200);
    expect(authorizations.at(-1)).toBe(`Bearer ${newToken}`);
});

it('does not lend an incumbent pending Session read to an identical-fields reinitialized prepared configuration', async () => {
    const issued = createDeferred<void>();
    const release = createDeferred<void>();
    let reads = 0;
    setRuntimeFetch(async (input, init) => {
        if (new URL(String(input)).pathname !== '/v2/sessions/read-batch') return Response.json({});
        reads += 1;
        if (reads === 1) { issued.resolve(); await release.promise; }
        return parts(init);
    });
    const firstBinding = prepare();
    const first = readSessionByIdHttp({ ...firstBinding, sessionId: 'session', token: oldToken, retry: 'none' })
        .then(() => 'disclosed', () => 'retired');
    await issued.promise;
    const nextBinding = prepare();
    const next = readSessionByIdHttp({ ...nextBinding, sessionId: 'session', token: oldToken, retry: 'none' })
        .catch(error => ({ error }));
    try {
        await vi.waitFor(() => expect(reads).toBe(2));
    } finally { release.resolve(); await Promise.all([first, next]); }
    await expect(first).resolves.toBe('retired');
    await expect(next).resolves.toMatchObject({ ok: true, body: { session: { id: 'session' } } });
});
