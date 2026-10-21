import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import {
    invalidateServerReachabilitySupervisor,
    peekServerReachabilityState,
    resetServerReachabilitySupervisors,
    setServerReachabilityNetworkAllowed,
    subscribeServerReachabilityState,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { createServerScopedRpcSocketPool } from './serverScopedRpcSocketPool';

afterEach(async () => {
    setServerReachabilityNetworkAllowed(true);
    await resetServerReachabilitySupervisors();
    resetRuntimeFetch();
    vi.useRealTimers();
});

describe('scoped socket pool with real reachability admission', () => {
    it('admits the socket only after its selected origin proves authenticated reachability', async () => {
        const transport = createSocketIoBoundaryStub();
        const requests: string[] = [];
        setRuntimeFetch(async (url, init) => {
            requests.push(String(url));
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
            return Response.json({ ok: true });
        });
        const pool = createServerScopedRpcSocketPool({ createSocket: () => transport.socket });
        try {
            const client = await pool.acquire({
                serverUrl: 'http://127.0.0.1:43111',
                reachabilityServerUrl: 'https://home.example.test',
                homeIdentityId: 'home-test', token: 'test-token', timeoutMs: 1000,
            });
            expect(client.connected).toBe(true);
            expect(requests).toEqual(['http://127.0.0.1:43111/v1/auth/ping']);
            client.disconnect();
        } finally { await pool.stopAll(); }
    });

    it('never dials when the selected origin is mis-bound to a non-Home HTTP endpoint', async () => {
        vi.useFakeTimers();
        const transport = createSocketIoBoundaryStub();
        setRuntimeFetch(async () => new Response(null, { status: 404 }));
        const pool = createServerScopedRpcSocketPool({ createSocket: () => transport.socket });
        try {
            const outcome = pool.acquire({ serverUrl: 'https://wrong.example.test', token: 'test-token', timeoutMs: 1000 })
                .then(() => null, (error: unknown) => error);
            await vi.advanceTimersByTimeAsync(1000);
            expect(await outcome).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT', connectionPhase: 'reachability-wait' });
            expect(transport.socket.connected).toBe(false);
            expect(transport.socket.connect).not.toHaveBeenCalled();
        } finally { await pool.stopAll(); }
    });

    it('identifies a pending authenticated probe separately from a pending socket handshake', async () => {
        vi.useFakeTimers();
        let respond!: (response: Response) => void;
        setRuntimeFetch(() => new Promise<Response>(resolve => { respond = resolve; }));
        const transport = createSocketIoBoundaryStub();
        const pool = createServerScopedRpcSocketPool({ createSocket: () => transport.socket });
        try {
            const outcome = pool.acquire({ serverUrl: 'https://slow.example.test', token: 'test-token', timeoutMs: 1000 })
                .then(() => null, (error: unknown) => error);
            await vi.advanceTimersByTimeAsync(1000);
            expect(await outcome).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT', connectionPhase: 'reachability-start' });
            expect(transport.socket.connect).not.toHaveBeenCalled();
        } finally {
            respond(Response.json({ ok: true }));
            await pool.stopAll();
        }
    });

    it('identifies a pending socket handshake after successful real reachability admission', async () => {
        vi.useFakeTimers();
        const transport = createSocketIoBoundaryStub({ autoConnect: false });
        setRuntimeFetch(async () => Response.json({ ok: true }));
        const pool = createServerScopedRpcSocketPool({ createSocket: () => transport.socket });
        try {
            const outcome = pool.acquire({ serverUrl: 'https://home.example.test', token: 'test-token', timeoutMs: 1000 })
                .then(() => null, (error: unknown) => error);
            await vi.advanceTimersByTimeAsync(1000);
            expect(await outcome).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT', connectionPhase: 'socket-connect' });
            expect(transport.socket.connect).toHaveBeenCalled();
        } finally { await pool.stopAll(); }
    });

    it('recovers the same retained pool entry after disconnect, an offline reachability verdict and reconnect', async () => {
        vi.useFakeTimers();
        const scope = { serverUrl: 'https://reconnect.example.test', token: 'test-token', timeoutMs: 1000 };
        let status = 200;
        setRuntimeFetch(async () => new Response(null, { status }));
        // The primary connection keeps observing this same Home/bearer across recovery.
        const unsubscribe = subscribeServerReachabilityState(scope.serverUrl, () => {}, scope.token);
        const transport = createSocketIoBoundaryStub();
        const pool = createServerScopedRpcSocketPool({ createSocket: () => transport.socket });
        try {
            const stream = await pool.acquire(scope);
            status = 503;
            transport.trigger('disconnect', 'transport close');
            await vi.advanceTimersByTimeAsync(0);
            expect(peekServerReachabilityState(scope.serverUrl, scope.token)?.phase).toBe('offline');
            const expired = pool.acquire(scope).then(() => null, (error: unknown) => error);
            await vi.advanceTimersByTimeAsync(1000);
            expect(await expired).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
            status = 200;
            await invalidateServerReachabilitySupervisor(scope);
            expect(peekServerReachabilityState(scope.serverUrl, scope.token)?.phase).toBe('online');
            const recovered = await pool.acquire(scope);
            expect(recovered.connected).toBe(true);
            expect(stream.connected).toBe(true);
            recovered.disconnect();
            stream.disconnect();
        } finally { await pool.stopAll(); unsubscribe(); }
    });

    it('retires a stalled reconnect while an unreachable report probe remains pending and admits a later call', async () => {
        vi.useFakeTimers();
        const scope = { serverUrl: 'https://stalled-reconnect.example.test', token: 'test-token', timeoutMs: 1000 };
        let respond: ((response: Response) => void) | undefined;
        let holdProbe = false;
        setRuntimeFetch(async () => holdProbe
            ? await new Promise<Response>(resolve => { respond = resolve; })
            : Response.json({ ok: true }));
        const unsubscribe = subscribeServerReachabilityState(scope.serverUrl, () => {}, scope.token);
        const transport = createSocketIoBoundaryStub();
        const pool = createServerScopedRpcSocketPool({ createSocket: () => transport.socket });
        try {
            const stream = await pool.acquire(scope);
            holdProbe = true;
            transport.trigger('disconnect', 'transport close');
            transport.socket.connect.mockImplementation(() => {});
            const expired = pool.acquire(scope).then(() => null, (error: unknown) => error);
            await vi.advanceTimersByTimeAsync(1000);
            expect(await expired).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT', connectionPhase: 'socket-connect' });
            holdProbe = false;
            respond?.(Response.json({ ok: true }));
            await vi.advanceTimersByTimeAsync(0);
            transport.socket.connect.mockImplementation(() => { transport.trigger('connect'); });
            const recovered = await pool.acquire(scope);
            expect(recovered.connected).toBe(true);
            expect(stream.connected).toBe(true);
            recovered.disconnect();
            stream.disconnect();
        } finally { respond?.(Response.json({ ok: true })); await pool.stopAll(); unsubscribe(); }
    });

    it('acquires a fresh connection in the same page after background retirement interrupts a dial', async () => {
        vi.useFakeTimers();
        const scope = { serverUrl: 'https://foreground-reconnect.example.test', token: 'test-token', timeoutMs: 1000 };
        setRuntimeFetch(async () => Response.json({ ok: true }));
        const transport = createSocketIoBoundaryStub({ autoConnect: false });
        const pool = createServerScopedRpcSocketPool({ createSocket: () => transport.socket });
        try {
            const expired = pool.acquire(scope).then(() => null, (error: unknown) => error);
            await vi.advanceTimersByTimeAsync(0);
            setServerReachabilityNetworkAllowed(false);
            await vi.advanceTimersByTimeAsync(0);
            expect(await expired).toMatchObject({ rpcErrorCode: 'MACHINE_RPC_UNREACHABLE' });
            setServerReachabilityNetworkAllowed(true);
            transport.socket.connect.mockImplementation(() => { transport.trigger('connect'); });
            const recovered = await pool.acquire(scope);
            expect(recovered.connected).toBe(true);
            recovered.disconnect();
        } finally { setServerReachabilityNetworkAllowed(true); await pool.stopAll(); }
    });
});
