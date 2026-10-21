import { describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from './serverAccountConnectionHarness';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('./serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));

// Resolve the real graph during collection; the neighbor's deadline measures
// Account/HTTP/RPC behavior, not the cold source compiler and module loader.
await import('@/sync/syncEngine');

describe('Socket transport boundary installation', () => {
    it('supports a hoisted static consumer and reconfiguration after importOriginal loads the SDK', async () => {
        installDisconnectedServerSocketBoundary(socket => { socket.auth = { fixture: 'first' }; });
        const first = io('https://import-order.test', { autoConnect: false });
        expect(first.auth).toEqual({ fixture: 'first' });
        expect(first.connect()).toBe(first);
        expect(first.connected).toBe(false);
        installDisconnectedServerSocketBoundary(socket => { socket.auth = { fixture: 'second' }; });
        const second = io('https://import-order.test', { autoConnect: false });
        expect(second.auth).toEqual({ fixture: 'second' });
        expect(second.connect()).toBe(second);
        expect(second.connected).toBe(false);
        // A subsequent import processes queued doMock registrations and evicts
        // the mock cache. Existing consumers still hold the valid delegate.
        await import('../hooks/createDeferred');
        installDisconnectedServerSocketBoundary(socket => { socket.auth = { fixture: 'third' }; });
        const third = io('https://import-order.test', { autoConnect: false });
        expect(third.auth).toEqual({ fixture: 'third' });
        first.disconnect();
        second.disconnect();
        third.disconnect();
        const scope = { serverUrl: 'https://replacement-principal.test', token: 'captured-principal' };
        const retired = installDisconnectedServerSocketBoundary(socket => {
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async () => ({ endpoint: 'retired' }));
        }, scope);
        const retained = io(scope.serverUrl, { autoConnect: false, auth: { token: scope.token } });
        expect(await retained.emitWithAck('rpc-call', {})).toEqual({ endpoint: 'retired' });
        const replacement = installDisconnectedServerSocketBoundary(socket => {
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async () => ({ endpoint: 'current' }));
        }, scope);
        retired.dispose();
        expect(await retained.emitWithAck('rpc-call', {})).toEqual({ endpoint: 'current' });
        replacement.dispose();
        await expect(retained.emitWithAck('rpc-call', {})).rejects.toThrow('responder retired');
        retained.disconnect();
    });

    it('keeps B HTTP and a real scoped RPC alive when retired Account A is disposed', async () => {
        const { installLocalStorageMock, installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
        const localStorage = installLocalStorageMock();
        const locks = installWebLockManagerMock();
        const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { storage } = await import('@/sync/domains/state/storage');
        const { runtimeFetch } = await import('@/utils/system/runtimeFetch');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        let releaseB!: () => void;
        const bReply = new Promise<void>(resolve => { releaseB = resolve; });
        let observeB!: () => void;
        const bIssued = new Promise<void>(resolve => { observeB = resolve; });
        let holdB = true;
        const capturedTransports: Array<Readonly<{ account: string; serverUrl: string | undefined; auth: unknown }>> = [];
        const createAccount = (account: string, serverUrl: string, activation?: 'switch') => restoreServerAccountForTest({
            serverUrl, accountId: account, activation,
            additionalRequestOrigins: ['https://socket-owner-a.test', 'https://socket-owner-b.test'],
            request: async (input, init) => {
                const requestUrl = new URL(String(input));
                const path = requestUrl.pathname;
                const requestAccount = requestUrl.hostname === 'socket-owner-a.test' ? 'socket-account-a' : 'socket-account-b';
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: requestAccount }));
                if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: settingsDefaults } });
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                    id => id === 'machine-1' ? createPlainMachineRowFixture({ id, accountId: requestAccount }) : null);
                if (path === '/v1/machines/machine-1') return Response.json({ machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: requestAccount }) });
                if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine-1', accountId: requestAccount })]);
                return null;
            },
            configureSocket: (socket, capturedUrl) => {
                capturedTransports.push({ account, serverUrl: capturedUrl, auth: socket.auth });
                socket.connect = vi.fn<typeof socket.connect>(() => {
                    if (!socket.connected) {
                        socket.connected = true;
                        for (const listener of socket.listeners('connect')) listener();
                    }
                    return socket;
                });
                socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
                socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async event => {
                    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
                    if (account === 'socket-account-b' && holdB) {
                        observeB();
                        await bReply;
                    }
                    return { ok: true, result: { account, serverUrl: capturedUrl } };
                });
            },
        });
        let a: Awaited<ReturnType<typeof createAccount>> | undefined;
        let b: Awaited<ReturnType<typeof createAccount>> | undefined;
        try {
            a = await createAccount('socket-account-a', 'https://socket-owner-a.test');
            const aCredentials = a.credentials;
            await vi.waitFor(() => expect(storage.getState().profile.id).toBe('socket-account-a'));
            const rpc = (connection: NonNullable<typeof a>, accountId: string) => machineRpcWithServerScope({
                serverId: connection.home.id, accountId, machineId: 'machine-1', method: 'fixture-ownership-probe', payload: {}, preferScoped: true,
            });
            await expect(rpc(a, 'socket-account-a')).resolves.toEqual({ account: 'socket-account-a', serverUrl: a.home.serverUrl });
            b = await createAccount('socket-account-b', 'https://socket-owner-b.test', 'switch');
            await vi.waitFor(() => expect(storage.getState().profile.id).toBe('socket-account-b'));
            // B's responder registration must not reroute a retained A socket.
            await expect(rpc(a, 'socket-account-a')).resolves.toEqual({ account: 'socket-account-a', serverUrl: a.home.serverUrl });
            const pendingB = rpc(b, 'socket-account-b');
            await bIssued;
            await a.dispose();
            a = undefined;
            const profile = await runtimeFetch(`${b.home.serverUrl}/v1/account/profile`);
            expect(AccountProfileSchema.parse(await profile.json()).id).toBe('socket-account-b');
            expect(await TokenStorage.getCredentialsForServerUrl(b.home.serverUrl, { serverId: b.home.id })).toEqual(b.credentials);
            releaseB();
            holdB = false;
            await expect(pendingB).resolves.toEqual({ account: 'socket-account-b', serverUrl: b.home.serverUrl });
            await expect(rpc(b, 'socket-account-b')).resolves.toEqual({ account: 'socket-account-b', serverUrl: b.home.serverUrl });
            for (const connection of capturedTransports) {
                const credentials = connection.account === 'socket-account-b' ? b.credentials : aCredentials;
                expect(connection.auth).toMatchObject({ token: credentials.token });
                expect(connection.serverUrl).toBe(connection.account === 'socket-account-b' ? 'https://socket-owner-b.test' : 'https://socket-owner-a.test');
            }
        } finally {
            releaseB();
            await a?.dispose();
            await b?.dispose();
            locks.restore();
            localStorage.restore();
        }
    });
});
