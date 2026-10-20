import { afterEach, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { installSessionOpsNetworkBoundary } from './sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from './syncSingletonLoader';

// Keep cold app initialization out of the individual transport assertions.
const initialNetwork = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
await initialNetwork.dispose();

let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>> | null = null;
afterEach(async () => {
    await network?.dispose();
    network = null;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    serverScopedRpcSocketPool.resetForTests();
});

it('keeps the scoped RPC owner real above the saved-Home HTTP and Socket ports', async () => {
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://session-ops-network.test', 'account-a');
    network.setRpcResponder(async request => ({ accepted: request.payload }));
    const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
    await expect(machineRpcWithServerScope({
        serverId: home.id, machineId: 'machine-a', method: 'fixture-operation',
        payload: { value: 'captured' }, preferScoped: true,
    })).resolves.toEqual({ accepted: { value: 'captured' } });
    expect(network.requests).toMatchObject([{
        serverUrl: home.serverUrl, token: home.token, targetId: 'machine-a',
        method: 'fixture-operation', payload: { value: 'captured' },
    }]);
});

it('reports an unconfigured RPC as the real typed remote method-not-found failure', async () => {
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://session-ops-missing-method.test', 'account-a');
    const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
    await expect(machineRpcWithServerScope({
        serverId: home.id, machineId: 'machine-a', method: 'missing-fixture-operation',
        payload: {}, preferScoped: true,
    })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
});

it('serves a replacement fixture through the Socket.IO import captured by the first installation', async () => {
    network = await installSessionOpsNetworkBoundary();
    const firstHome = await network.addHome('https://session-ops-replacement.test', 'account-replacement');
    network.setRpcResponder(async () => ({ result: 'first' }));
    const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
    const read = (serverId: string) => machineRpcWithServerScope({ serverId, machineId: 'machine-a',
        method: 'fixture-replacement', payload: {}, preferScoped: true });
    await expect(read(firstHome.id)).resolves.toEqual({ result: 'first' });
    await network.dispose();
    network = await installSessionOpsNetworkBoundary();
    const replacementHome = await network.addHome('https://session-ops-replacement.test', 'account-replacement');
    network.setRpcResponder(async request => ({ result: 'replacement', home: request.serverUrl }));
    // Same Home and credential deliberately reuse the pool key. Disposal must
    // retire the old fixture's socket, not retain its cleared response closure.
    await expect(read(replacementHome.id)).resolves.toEqual({
        result: 'replacement', home: replacementHome.serverUrl,
    });
    expect(network.socketBoundaries).toMatchObject([{ serverUrl: replacementHome.serverUrl, token: replacementHome.token }]);
});

it('keeps a retained Socket responder and ACK budget across restored spies and fixture reset', async () => {
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://session-ops-retained.test', 'account-retained');
    const { io } = await import('socket.io-client');
    const socket = io(home.serverUrl, { autoConnect: false, auth: { token: home.token } });
    network.setSocketAckResponder(async request => ({ result: 'before', timeoutMs: request.timeoutMs }));
    await expect(socket.timeout(1_234).emitWithAck('update-read-cursor', { sid: 'session-a' }))
        .resolves.toEqual({ result: 'before', timeoutMs: 1_234 });
    vi.restoreAllMocks();
    network.resetRequests();
    network.setSocketAckResponder(async request => ({ result: 'after', timeoutMs: request.timeoutMs }));
    await expect(socket.timeout(4_321).emitWithAck('update-read-cursor', { sid: 'session-b' }))
        .resolves.toEqual({ result: 'after', timeoutMs: 4_321 });
});

it('reinstalls the captured HTTP and credential ports when a reused fixture resets requests', async () => {
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://session-ops-reset.test', 'account-a');
    const { runtimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const original = await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
    expect(original).toEqual({ token: home.token });
    resetRuntimeFetch();
    network.resetRequests();
    const response = await runtimeFetch(home.serverUrl + '/health');
    expect(response.status).toBe(200);
    expect(network.httpRequests).toHaveLength(1);
    // Account restoration composes the same captured HTTP port, not another Home fixture.
    expect((await network.request(home.serverUrl + '/health')).status).toBe(200);
    expect(network.httpRequests).toHaveLength(2);
    await network.setAccount(home.serverUrl, 'account-b');
    const replacement = await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
    expect(replacement?.token).not.toBe(home.token);
});

it('serves default Account Settings through its authenticated Home HTTP port', async () => {
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://session-ops-settings.test', 'account-settings');
    const { AccountSettingsV2GetResponseSchema } = await import('@happier-dev/protocol/account/settings/accountSettingsApiV2');
    const response = await network.request(`${home.serverUrl}/v2/account/settings`, {
        headers: { Authorization: `Bearer ${home.token}` },
    });
    expect(response.status).toBe(200);
    expect(AccountSettingsV2GetResponseSchema.parse(await response.json())).toEqual({
        content: { t: 'plain', v: {} }, version: 1,
    });
});

it('publishes saved-Home custody through the real credential store and rolls it back on disposal', async () => {
    network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://session-ops-real-custody.test', 'account-a');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    // Retire observation so this keeper reads the actual device store without a spy.
    if (vi.isMockFunction(TokenStorage.getCredentialsForServerUrl)) vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual({ token: home.token });
    await network.dispose();
    expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBeNull();
});

it('owns browser storage for web fixtures without replacing an existing device port', async () => {
    const { Platform } = await import('react-native');
    const platform = Platform.OS;
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Reflect.set(Platform, 'OS', 'web');
    Reflect.deleteProperty(globalThis, 'localStorage');
    try {
        network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://session-ops-web-custody.test', 'account-a');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual({ token: home.token });
        await network.dispose();
        network = null;
        expect(Object.getOwnPropertyDescriptor(globalThis, 'localStorage')).toBeUndefined();
        const { installLocalStorageMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
        const browser = installLocalStorageMock();
        try {
            const storage = globalThis.localStorage;
            network = await installSessionOpsNetworkBoundary();
            expect(globalThis.localStorage).toBe(storage);
            await network.dispose();
            network = null;
            expect(globalThis.localStorage).toBe(storage);
        } finally { browser.restore(); }
    } finally {
        await network?.dispose();
        network = null;
        Reflect.set(Platform, 'OS', platform);
        if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    }
});
