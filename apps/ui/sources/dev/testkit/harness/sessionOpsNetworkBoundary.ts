import { vi } from 'vitest';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';

export type SessionOpsRpcRequest = Readonly<{
    serverUrl: string;
    token: string | undefined;
    targetId: string;
    method: string;
    payload: unknown;
    timeoutMs: number | null;
}>;

export type SessionOpsRpcAck =
    | Readonly<{ ok: true; result: unknown }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

export type SessionOpsSocketAckRequest = Readonly<{
    serverUrl: string;
    token: string | undefined;
    event: string;
    payload: unknown;
    timeoutMs: number | null;
}>;

type SessionOpsHttpResponder = (...args: Parameters<RuntimeFetch>) => Promise<Response | null>;
type SessionOpsSocketBoundary = ReturnType<typeof import('../mocks/socketIo').createSocketIoBoundaryStub> & Readonly<{
    serverUrl: string;
    token: string | undefined;
}>;

export type SessionOpsNetworkBoundary = Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;

/** Scoped operations use real Home/Account admission and credentials; only network transports are replaced. */
export async function installSessionOpsNetworkBoundary() {
    const requests: SessionOpsRpcRequest[] = [];
    const responses = new Map<string, unknown>();
    let rpcResponder: ((request: SessionOpsRpcRequest) => Promise<unknown>) | null = null;
    let rpcAckResponder: ((request: SessionOpsRpcRequest) => Promise<SessionOpsRpcAck>) | null = null;
    let httpResponder: SessionOpsHttpResponder | null = null;
    let socketAckResponder: ((request: SessionOpsSocketAckRequest) => Promise<unknown | null>) | null = null;
    let socketConfigurator: ((boundary: SessionOpsSocketBoundary) => void) | null = null;
    const sockets: Array<{ disconnect(): unknown }> = [];
    const socketBoundaries: SessionOpsSocketBoundary[] = [];
    vi.doMock('socket.io-client', async (importOriginal) => {
        const actual = await importOriginal<typeof import('socket.io-client')>();
        const { createSocketIoBoundaryStub } = await import('../mocks/socketIo');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        const { RPC_ERROR_CODES } = await import('@happier-dev/protocol/rpc');
        return {
            ...actual,
            io: (serverUrl: string, options: { auth?: { token?: string } }) => {
                const boundary = createSocketIoBoundaryStub();
                const { socket } = boundary;
                sockets.push(socket);
                const recordedBoundary = { ...boundary, serverUrl, token: options.auth?.token };
                socketBoundaries.push(recordedBoundary);
                let timeoutMs: number | null = null;
                socket.timeout.mockImplementation((value) => {
                    timeoutMs = value;
                    return { emitWithAck: socket.emitWithAck };
                });
                socket.emitWithAck.mockImplementation(async (event, payload) => {
                    if (event !== SOCKET_RPC_EVENTS.CALL) {
                        const response = socketAckResponder ? await socketAckResponder({
                            serverUrl, token: options.auth?.token, event, payload, timeoutMs,
                        }) : null;
                        return response !== null ? response : { v: 1, ok: true, admittedSessionIds: [] };
                    }
                    if (!payload || typeof payload !== 'object' || !('method' in payload)
                        || typeof payload.method !== 'string' || !('params' in payload)) {
                        throw new Error('Malformed Socket RPC request');
                    }
                    const separator = payload.method.indexOf(':');
                    const method = payload.method.slice(separator + 1);
                    const request: SessionOpsRpcRequest = { serverUrl, token: options.auth?.token,
                        targetId: payload.method.slice(0, separator), method, payload: payload.params, timeoutMs };
                    requests.push(request);
                    if (rpcAckResponder) return await rpcAckResponder(request);
                    if (rpcResponder) return { ok: true, result: await rpcResponder(request) };
                    if (!responses.has(method)) {
                        return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                    }
                    return { ok: true, result: responses.get(method) };
                });
                socketConfigurator?.(recordedBoundary);
                return socket;
            },
        };
    });

    // This harness serves scoped saved Homes. It does not fabricate a focused Sync Account.
    const { upsertServerProfile, resolveUniqueServerProfileByUrl } = await import('@/sync/domains/server/serverProfiles');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { createPlainMachineRowFixture } = await import('../fixtures/machineFixtures');
    const { createAccountTokenForTests } = await import('./homeGovernanceHarness');
    const { canonicalizeServerUrl } = await import('@/sync/domains/server/url/serverUrlCanonical');
    const homes = new Set<string>();
    const accountIdsByHome = new Map<string, string>();
    const credentialWrites: Array<NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>> = [];
    const credentialRequests: Array<{ serverUrl: string; serverId: string | undefined }> = [];
    const readCredentials = TokenStorage.getCredentialsForServerUrl;
    const observeCredentialRead: typeof TokenStorage.getCredentialsForServerUrl = async (serverUrl, options) => {
        credentialRequests.push({ serverUrl, serverId: options?.serverId ?? undefined });
        return await readCredentials.call(TokenStorage, serverUrl, options);
    };
    // Observation only: the real credential owner admits every served and unserved Home.
    let credentialObserver = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(observeCredentialRead);
    const httpRequests: Array<{ url: string; token: string | null }> = [];
    const runtimeFetchBoundary: RuntimeFetch = async (input, init) => {
        const url = new URL(String(input));
        const token = new Headers(init?.headers).get('authorization');
        httpRequests.push({ url: url.href, token });
        if (!homes.has(url.origin)) throw new Error(`Unexpected test Home: ${url.origin}`);
        const response = httpResponder ? await httpResponder(input, init) : null;
        if (response !== null) return response;
        // Public saved-Home discovery uses a tokenless readiness probe whose
        // contract is the HTTP status, not a response body.
        if (url.pathname === '/health') return new Response(null, { status: 200 });
        if (url.pathname === '/v1/auth/ping') return Response.json({});
        const accountId = accountIdsByHome.get(url.origin);
        if (!accountId) throw new Error(`Test Home Account is unavailable: ${url.origin}`);
        if (url.pathname === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine-1', accountId })]);
        if (url.pathname.startsWith('/v1/machines/')) return Response.json({ machine: createPlainMachineRowFixture({
            id: decodeURIComponent(url.pathname.slice('/v1/machines/'.length)), accountId,
        }) });
        return Response.json({}, { status: 404 });
    };
    setRuntimeFetch(runtimeFetchBoundary);
    return {
        requests,
        httpRequests,
        credentialRequests,
        socketBoundaries,
        resetRequests() {
            // The global UI cleanup retires runtimeFetch after every test.
            setRuntimeFetch(runtimeFetchBoundary);
            credentialObserver.mockRestore();
            credentialObserver = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(observeCredentialRead);
            requests.length = 0;
            httpRequests.length = 0;
            credentialRequests.length = 0;
            socketBoundaries.length = 0;
            responses.clear();
            rpcResponder = null;
            rpcAckResponder = null;
            httpResponder = null;
            socketAckResponder = null;
            socketConfigurator = null;
        },
        respond(method: string, response: unknown) { responses.set(method, response); },
        setRpcResponder(responder: (request: SessionOpsRpcRequest) => Promise<unknown>) {
            rpcResponder = responder;
        },
        setRpcAckResponder(responder: (request: SessionOpsRpcRequest) => Promise<SessionOpsRpcAck>) {
            rpcAckResponder = responder;
        },
        setHttpResponder(responder: SessionOpsHttpResponder) {
            httpResponder = responder;
        },
        setSocketAckResponder(responder: (request: SessionOpsSocketAckRequest) => Promise<unknown | null>) {
            socketAckResponder = responder;
        },
        setSocketConfigurator(configure: (boundary: SessionOpsSocketBoundary) => void) {
            socketConfigurator = configure;
        },
        async setAccount(homeUrl: string, accountId: string) {
            const serverUrl = canonicalizeServerUrl(homeUrl);
            if (!homes.has(serverUrl)) throw new Error(`Test Home is not registered: ${serverUrl}`);
            const profile = resolveUniqueServerProfileByUrl(serverUrl);
            if (!profile) throw new Error(`Test Home profile is not uniquely registered: ${serverUrl}`);
            const write = await TokenStorage.setCredentialsForServerUrlWithRollback(
                serverUrl, { serverId: profile.id }, { token: createAccountTokenForTests(accountId) },
            );
            if (!write) throw new Error(`Test Home credentials could not be stored: ${serverUrl}`);
            credentialWrites.push(write);
            accountIdsByHome.set(serverUrl, accountId);
        },
        async addHome(serverUrl: string, accountId: string) {
            const profile = await upsertServerProfile({ serverUrl, name: accountId });
            const token = createAccountTokenForTests(accountId);
            const write = await TokenStorage.setCredentialsForServerUrlWithRollback(
                profile.serverUrl, { serverId: profile.id }, { token },
            );
            if (!write) throw new Error(`Test Home credentials could not be stored: ${profile.serverUrl}`);
            credentialWrites.push(write);
            homes.add(profile.serverUrl);
            accountIdsByHome.set(profile.serverUrl, accountId);
            return { ...profile, accountId, token };
        },
        async dispose() {
            rpcResponder = null;
            rpcAckResponder = null;
            httpResponder = null;
            socketAckResponder = null;
            socketConfigurator = null;
            for (const socket of sockets) socket.disconnect();
            resetRuntimeFetch();
            credentialObserver.mockRestore();
            vi.doUnmock('socket.io-client');
            for (const write of credentialWrites.splice(0).reverse()) await write.rollback();
        },
    };
}
