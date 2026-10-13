import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER, PEER_MEDIATION_RECEIPTS,
    PeerLoopbackEndpointCandidateV1Schema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { PEER_MACHINE_RPC_DIRECT_PATH_V2, PeerMachineRpcDirectRequestV2Schema,
    PeerMachineRpcDirectResponseV2Schema } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import { SOCKET_RPC_EVENTS, SocketRpcTimeoutMsSchema, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { readRpcRequestDisposition, socketRpcCodec } from '@happier-dev/sync-client';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { machineRpcWithServerScope } from './serverScopedMachineRpc';
import { resetScopedMachineTransportCacheForTests } from './serverScopedRpcPool';
import { serverScopedRpcSocketPool } from './serverScopedRpcSocketPool';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { clearMachineRequestReachabilityForTest, clearMachineRequestReachabilityForMachine,
    readMachineRequestReachabilityObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const credentials = vi.hoisted(() => ({ token: '' }));

// Credential persistence is the only device boundary. HTTP and Socket.IO run in process.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return await createTokenStorageModuleMock({
        importOriginal,
        subscribeHomeCredentialMutations: actual.subscribeHomeCredentialMutations,
        tokenStorage: { getCredentialsForServerUrl: async () => ({ token: credentials.token }) },
    });
});

afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    clearMachineRequestReachabilityForTest();
    resetServerFeaturesClientForTests();
});

async function listen(http: HttpServer, port = 0) {
    await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    return address.port;
}

async function closeHttp(http: HttpServer) {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
}

async function createDirectRelayHome(endpointPort: number, relayReply?: Promise<void>) {
    const features = FeaturesResponseSchema.parse({ features: { machines: {
        enabled: true, rpc: { enabled: true, directPeer: { enabled: true } },
    } }, capabilities: {} });
    const http = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/features') response.end(JSON.stringify(features));
        else if (request.url === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        else if (request.url === '/v1/machines/machine-1') {
            response.end(JSON.stringify({ machine: { id: 'machine-1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } }));
        } else if (request.url === '/v1/machines/peer/mediation/route-grants') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const grantRequest = DirectRouteGrantRequestV2Schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
            const now = Date.now();
            const grant = SignedDirectRouteGrantV2Schema.parse({ payload: {
                v: 2, grantId: 'hh-grant', accountId: 'account-a', machineId: grantRequest.machineId,
                flowKind: grantRequest.flowKind, routeKind: grantRequest.routeKind, scope: grantRequest.scope,
                iat: now, exp: now + grantRequest.ttlMs, aud: 'happier-daemon-route-grant',
                endpointFingerprint: grantRequest.endpointFingerprint, proofKind: 'ephemeral_ed25519',
                ephemeralPublicKeyBase64Url: grantRequest.ephemeralPublicKeyBase64Url,
            }, signature: { keyId: 'hh-key', alg: 'Ed25519', valueBase64Url: Buffer.alloc(64, 2).toString('base64url') } });
            response.end(JSON.stringify({ ok: true, grant }));
        } else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    const calls: SocketRpcRequestPayload[] = [];
    relay.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, async (packet: SocketRpcRequestPayload, ack: (response: unknown) => void) => {
            calls.push(packet);
            if (packet.method !== `machine-1:${RPC_METHODS.DAEMON_MEMORY_STATUS}`) {
                ack({ ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
                return;
            }
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            await relayReply;
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, {
                route: 'relay', params: decoded.params,
            }, decoded.callId) });
        });
    });
    const homePort = await listen(http);
    credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${homePort}`, name: 'HH direct/relay Home' });
    const endpoint = PeerLoopbackEndpointCandidateV1Schema.parse({ v: 1, routeKind: 'loopback_direct',
        url: `http://127.0.0.1:${endpointPort}/`, endpointFingerprint: 'hh-endpoint', expiresAt: Date.now() + 300_000 });
    const machine = createMachineFixture({ daemonState: { peerMediation: { loopback: { endpoint } } } });
    getStorage().setState({ machineListByServerId: { [home.id]: [machine] } });
    return { calls, scope: { serverId: home.id, accountId: 'account-a' },
        call: (options: { timeoutMs?: number; signal?: AbortSignal } = {}) => machineRpcWithServerScope({
            serverId: home.id, accountId: 'account-a', machineId: machine.id,
            method: RPC_METHODS.DAEMON_MEMORY_STATUS, payload: { includeWorkers: true }, preferScoped: true,
            timeoutMs: options.timeoutMs ?? 4_000, signal: options.signal }),
        close: async () => {
            await serverScopedRpcSocketPool.stopAll();
            await new Promise<void>(resolve => relay.close(() => resolve()));
        } };
}

it('relays an unreachable direct endpoint, skips it after relay success, and retries it after the exact reconnect', async () => {
    const reservation = createServer();
    const port = await listen(reservation);
    await closeHttp(reservation);
    const home = await createDirectRelayHome(port);
    let directPosts = 0;
    let directOptions = 0;
    const direct = createServer(async (request, response) => {
        if (request.method === 'OPTIONS') {
            directOptions++;
            response.writeHead(204).end();
            return;
        }
        directPosts++;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const rpc = PeerMachineRpcDirectRequestV2Schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
        expect(request.url).toBe(PEER_MACHINE_RPC_DIRECT_PATH_V2);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(PeerMachineRpcDirectResponseV2Schema.parse({ v: 2, ok: true,
            receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded, requestId: rpc.requestId, method: rpc.method,
            routeKind: 'loopback_direct', result: { route: 'direct', params: rpc.params } })));
    });
    let directListening = false;
    try {
        await expect(home.call()).resolves.toEqual({ route: 'relay', params: { includeWorkers: true } });
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1', 'loopback_direct')?.outcome).toBe('failed');
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1')?.outcome).toBe('succeeded');
        await listen(direct, port);
        directListening = true;
        await expect(home.call()).resolves.toMatchObject({ route: 'relay' });
        expect(directOptions + directPosts).toBe(0);
        clearMachineRequestReachabilityForMachine(home.scope, 'machine-1');
        await expect(home.call()).resolves.toEqual({ route: 'direct', params: { includeWorkers: true } });
        expect(directPosts).toBe(1);
        expect(home.calls).toHaveLength(2);
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1', 'loopback_direct')?.outcome).toBe('succeeded');
    } finally {
        if (directListening) await closeHttp(direct);
        await home.close();
    }
});

it.each(['lost', 'http-error'] as const)('never replays an accepted direct POST with a %s response, even when the relay is healthy', async (failure) => {
    let effects = 0;
    const direct = createServer(async (request, response) => {
        if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
        for await (const _chunk of request) { /* Consume the delivered request before losing its reply. */ }
        effects++;
        if (failure === 'lost') response.destroy();
        else response.writeHead(500).end('{}');
    });
    const home = await createDirectRelayHome(await listen(direct));
    try {
        const error = await home.call().catch((cause: unknown) => cause);
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        expect(effects).toBe(1);
        expect(home.calls).toHaveLength(0);
    } finally {
        await closeHttp(direct);
        await home.close();
    }
});

it('spends the same caller deadline on direct readiness and relay, without renewing the budget', async () => {
    const relayReply = createDeferred<void>();
    const direct = createServer((_request, response) => {
        setTimeout(() => response.destroy(), 150);
    });
    const home = await createDirectRelayHome(await listen(direct), relayReply.promise);
    try {
        const error = await home.call({ timeoutMs: 1_000 }).catch((cause: unknown) => cause);
        expect(error).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT', timeoutMs: 1_000 });
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        expect(home.calls).toHaveLength(1);
        const remaining = SocketRpcTimeoutMsSchema.parse(home.calls[0]?.timeoutMs);
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThanOrEqual(850);
    } finally {
        relayReply.resolve();
        await closeHttp(direct);
        await home.close();
    }
});

it('cancels direct readiness before RPC delivery without relaying or poisoning the route', async () => {
    const arrived = createDeferred<void>();
    let directPosts = 0;
    const direct = createServer((request) => {
        if (request.method === 'POST') directPosts++;
        arrived.resolve();
    });
    const home = await createDirectRelayHome(await listen(direct));
    const controller = new AbortController();
    try {
        const pending = home.call({ signal: controller.signal }).catch((cause: unknown) => cause);
        await arrived.promise;
        controller.abort();
        const error = await pending;
        expect(error).toMatchObject({ code: 'MACHINE_RPC_ABORTED' });
        expect(readRpcRequestDisposition(error)).toBe('notSent');
        expect(directPosts).toBe(0);
        expect(home.calls).toHaveLength(0);
        expect(readMachineRequestReachabilityObservation(home.scope, 'machine-1', 'loopback_direct')).toBeNull();
    } finally {
        await closeHttp(direct);
        await home.close();
    }
});

it('spends the caller deadline through the real Home HTTP and Socket.IO transport', async () => {
    const deadlineMs = 4_000;
    const http = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') {
            response.end('{}');
        } else if (request.url === '/v1/account/encryption') {
            response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        } else if (request.url === '/v1/machines/machine-1') {
            response.end(JSON.stringify({ machine: { id: 'machine-1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } }));
        } else if (request.url === '/v1/features') {
            response.statusCode = 404;
            response.end('{}');
        } else {
            response.statusCode = 404;
            response.end('{}');
        }
    });
    const server = new Server(http, { path: '/v1/updates/' });
    let observeRequest!: (value: unknown) => void;
    const received = new Promise<unknown>((resolve) => { observeRequest = resolve; });
    let calls = 0;
    server.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, (request: unknown) => {
            calls += 1;
            observeRequest(request);
            // The daemon has accepted the request but never returns an ACK.
        });
    });
    await new Promise<void>(resolve => { http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback Home address');
    credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
    try {
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${address.port}`, name: 'Loopback Home' });
        const pending = machineRpcWithServerScope({ serverId: home.id, machineId: 'machine-1',
            method: 'method-test', payload: { probe: true }, preferScoped: true, timeoutMs: deadlineMs })
            .catch((error: unknown) => error);
        const request = await Promise.race([
            received,
            pending.then(() => { throw new Error('Machine RPC settled before reaching the Socket.IO transport'); }),
        ]);
        expect(request).toMatchObject({ method: 'machine-1:method-test' });
        if (!request || typeof request !== 'object' || !('params' in request) || !('timeoutMs' in request)) {
            throw new Error('Missing RPC parameters or the propagated deadline');
        }
        expect(await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.params, 'machine-1:method-test'))
            .toMatchObject({ params: { probe: true } });
        const transportTimeoutMs = SocketRpcTimeoutMsSchema.parse(request.timeoutMs);
        expect(transportTimeoutMs).toEqual(expect.any(Number));
        expect(transportTimeoutMs).toBeGreaterThan(0);
        expect(transportTimeoutMs).toBeLessThanOrEqual(deadlineMs);
        const error = await pending;
        expect(error).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT', timeoutMs: deadlineMs });
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        expect(calls).toBe(1);
    } finally {
        await serverScopedRpcSocketPool.stopAll();
        await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
});
