import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { AccountProfileSchema, PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { createOkFetchResponse, createServerFetchWithReachabilityProbe, getServerFetchUrl, renderHook, flushHookEffects } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { parseNotificationTap } from '../notificationRouting';
import { executeNotificationPermissionAction, handleNotificationBackgroundTask } from './notificationPermissionActions';
import { resolveNotificationPermissionTarget } from './resolveNotificationPermissionTarget';
import { initializeNotificationBackgroundTask, resetNotificationBackgroundTaskStateForTests } from './notificationBackgroundTaskState';
import { useNotificationResponseRouting } from './useNotificationResponseRouting';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedSessionDataKeyCacheForTests, resolveScopedSessionCryptoContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { isServerReachabilityNetworkAllowed, resetServerReachabilitySupervisors, setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

const boundary = vi.hoisted(() => ({
    secrets: new Map<string, string>(),
    rpc: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    push: vi.fn(),
    navigate: vi.fn(),
    disconnect: vi.fn(),
    alert: vi.fn(),
    connectsImmediately: true,
    connect: vi.fn(),
    completeConnection: null as null | (() => void),
    listener: null as null | ((response: unknown) => void),
    lastResponse: null as unknown,
}));

// Native secure storage, React Native, Expo responses, and socket.io are the
// system boundaries. Profile/auth/parser/coordinator/scoped RPC logic stays real.
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => boundary.secrets.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { boundary.secrets.set(key, value); },
    deleteItemAsync: async (key: string) => { boundary.secrets.delete(key); },
}));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' }, { AppState: { currentState: 'active' } });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: boundary.push, navigate: boundary.navigate } }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: boundary.alert } }).module;
});
vi.mock('expo-notifications', () => ({
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    getLastNotificationResponseAsync: async () => boundary.lastResponse,
    clearLastNotificationResponseAsync: async () => { boundary.lastResponse = null; },
    addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
        boundary.listener = listener;
        return { remove: () => { boundary.listener = null; } };
    },
}));
vi.mock('socket.io-client', () => ({
    io: () => {
        const listeners = new Map<string, Set<() => void>>();
        boundary.completeConnection = () => { for (const listener of listeners.get('connect') ?? []) listener(); };
        return {
            connected: boundary.connectsImmediately,
            on: (event: string, listener: () => void) => {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event)?.add(listener);
            },
            off: (event: string, listener: () => void) => { listeners.get(event)?.delete(listener); },
            connect: boundary.connect, disconnect: boundary.disconnect, emit: () => {},
            emitWithAck: (...args: unknown[]) => boundary.rpc(...args),
            timeout: () => ({ emitWithAck: (...args: unknown[]) => boundary.rpc(...args) }),
        };
    },
}));

const serverUrl = 'https://notifications.example.test';
let responseSequence = 0;
function token(account = 'account') { return `e30.${btoa(JSON.stringify({ sub: account }))}.signature`; }
function response(actionIdentifier = PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1 as string, identifier: string | null = `n${responseSequence}`) {
    return { actionIdentifier, notification: { request: { identifier, content: { data: { serverUrl, sessionId: 'session', requestId: 'request', occurrenceId: `occurrence-${responseSequence}` } } } } };
}
function parsed(value = response()) {
    const tap = parseNotificationTap({ response: value, defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
    if (!tap) throw new Error('Fixture did not parse');
    return tap;
}

function expectSessionNavigationToServer(serverId: string, callIndex = 0) {
    const navigation = new URL(String(boundary.navigate.mock.calls[callIndex]?.[0]), 'https://ui.example.test');
    expect(navigation.pathname).toBe('/session/session');
    expect(profiles.areServerProfileIdentifiersEquivalent(navigation.searchParams.get('serverId') ?? '', serverId)).toBe(true);
}

describe('Android notification permission entry points', () => {
    beforeEach(async () => {
        responseSequence += 1;
        Platform.OS = 'android';
        // Exercise production secure storage, not the development entitlement fallback.
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK', 'false');
        setServerReachabilityNetworkAllowed(true);
        boundary.secrets.clear();
        boundary.rpc.mockReset().mockResolvedValue({ ok: true, result: { ok: true } });
        boundary.push.mockClear();
        boundary.navigate.mockClear();
        boundary.disconnect.mockClear();
        boundary.alert.mockClear();
        boundary.connectsImmediately = true;
        boundary.connect.mockClear();
        boundary.completeConnection = null;
        boundary.lastResponse = null;
        resetNotificationBackgroundTaskStateForTests();
        resetScopedSessionDataKeyCacheForTests();
        const profile = profiles.upsertServerProfile({ serverUrl, name: 'Test' });
        profiles.setServerProfileIdentityForUrl(serverUrl, 'srv_notification_identity');
        profiles.setActiveServerId(profile.id, { scope: 'device' });
        expect(await TokenStorage.setCredentials({ token: token() })).toBe(true);
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId: 'srv_notification_identity', accountId: 'account' } });
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => {
            const { pathname } = getServerFetchUrl(input);
            if (pathname === '/v2/sessions/session') {
                return createOkFetchResponse({
                    session: { id: 'session', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                        metadata: '{}', metadataVersion: 0, agentState: null, agentStateVersion: 0,
                        pendingCount: 0, pendingVersion: 0, encryptionMode: 'plain', dataEncryptionKey: null },
                });
            }
            // Canonical session navigation can switch Home and refresh these endpoints.
            if (pathname === '/v1/account/profile') return createOkFetchResponse(AccountProfileSchema.parse({ id: 'account' }));
            if (pathname === '/v1/artifacts') return createOkFetchResponse([]);
            return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        })));
    });
    afterEach(async () => {
        setServerReachabilityNetworkAllowed(true);
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        await resetServerReachabilitySupervisors();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('executes a foreground press even with task registration and coalesces the task race', async () => {
        await initializeNotificationBackgroundTask('android', () => ({ registerNotificationBackgroundTask: async () => true }));
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        await act(async () => {
            boundary.listener?.(response());
            await handleNotificationBackgroundTask({ data: response() });
        });
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.push).not.toHaveBeenCalled();
        expect(profiles.getActiveServerUrl()).toBe(serverUrl);
        await hook.unmount();
    });

    it('keeps a confirmed background response from becoming a false review notice on later listener delivery', async () => {
        const { consumeNotificationPermissionRecoveryNeeded } = await import('./notificationPermissionRecovery');
        consumeNotificationPermissionRecoveryNeeded();
        const nativeResponse = response();
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            expect(boundary.listener).toEqual(expect.any(Function));
            await expect(handleNotificationBackgroundTask({ data: nativeResponse })).resolves.toMatchObject({ status: 'confirmed' });
            // The actual CLI no longer has a pending waiter after accepting this occurrence.
            boundary.rpc.mockResolvedValue({ ok: true, result: { ok: false, errorCode: 'permission_request_not_found' } });
            await act(async () => { boundary.listener?.(nativeResponse); });
            await flushHookEffects();
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            expect(boundary.alert).not.toHaveBeenCalled();
            expect(consumeNotificationPermissionRecoveryNeeded()).toBe(false);
            expect(boundary.push).not.toHaveBeenCalled();
            expect(boundary.navigate).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('uses the current application result for a later permission occurrence', async () => {
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'confirmed' });
        responseSequence += 1;
        boundary.rpc.mockResolvedValue({ ok: true, result: { ok: false, errorCode: 'permission_request_not_found' } });
        await expect(handleNotificationBackgroundTask({ data: response(undefined, 'another') })).resolves.toMatchObject({ status: 'rejected' });
        await expect(handleNotificationBackgroundTask({ data: response(undefined, null) })).resolves.toMatchObject({ status: 'rejected' });
        await expect(executeNotificationPermissionAction(parsed(response(PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1)))).resolves.toMatchObject({ status: 'rejected' });
        expect(boundary.rpc).toHaveBeenCalledTimes(4);
    });

    it('executes a background press while normal app networking is paused', async () => {
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        // Sync closes this real gate when a running native app enters background.
        // A headless action must not need to resume all foreground networking.
        setServerReachabilityNetworkAllowed(false);
        vi.useFakeTimers();
        try {
            const foreground = resolveScopedSessionCryptoContext({
                serverId: 'srv_notification_identity', serverUrl, token: token(), sessionId: 'session',
                decryptEncryptionKey: async () => null,
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(fetch).not.toHaveBeenCalled();
            const pending = handleNotificationBackgroundTask({ data: response() });
            await vi.advanceTimersByTimeAsync(30_000);
            await expect(pending).resolves.toMatchObject({ status: 'confirmed' });
            await expect(foreground).resolves.toMatchObject({ encryptionMode: 'unknown' });
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            expect(boundary.disconnect).toHaveBeenCalledTimes(1);
            expect(boundary.push).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('resolves canonical active and inactive saved server scopes without changing the selected server', async () => {
        expect(await resolveNotificationPermissionTarget(serverUrl.toUpperCase() + '/')).toEqual({ serverId: 'srv_notification_identity', accountId: 'account' });
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'confirmed' });
        expect(profiles.getActiveServerUrl()).toBe(other.serverUrl);
    });

    it('applies denial thinking recovery for the active scope but never for another scope', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const initialState = storage.getState();
        try {
            const session = {
                id: 'session', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
                thinking: true, thinkingAt: 1, presence: 'online' as const,
            };
            storage.getState().applySessions([session]);
            storage.getState().markSessionOptimisticThinking('session');
            await expect(executeNotificationPermissionAction(parsed(response(PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1))))
                .resolves.toMatchObject({ status: 'confirmed' });
            expect(storage.getState().sessions['session']?.thinking).toBe(false);

            // Same decision against a now-inactive server scope: the authenticated
            // send still works, but it must not touch the active scope's UI state.
            storage.getState().applySessions([{ ...session, thinking: true }]);
            const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
            profiles.setActiveServerId(other.id, { scope: 'device' });
            await TokenStorage.setCredentials({ token: token('other-account') });
            const foreign = parsed(response(PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1, 'n2'));
            await expect(executeNotificationPermissionAction({ ...foreign, permissionAction: { ...foreign.permissionAction!, requestId: 'foreign-request' } }))
                .resolves.toMatchObject({ status: 'confirmed' });
            expect(storage.getState().sessions['session']?.thinking).toBe(true);
            expect(profiles.getActiveServerUrl()).toBe(other.serverUrl);
        } finally {
            storage.setState(initialState, true);
        }
    });

    it('does not issue without credentials, rejects mismatched account hints, then allows a fresh press to retry', async () => {
        await TokenStorage.removeCredentials();
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
        await TokenStorage.setCredentials({ token: token('replacement') });
        await expect(executeNotificationPermissionAction({ ...parsed(), accountId: 'account' })).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'confirmed' });
    });

    it('fails closed for absent scope and invalid authentication', async () => {
        expect(await resolveNotificationPermissionTarget('not a URL')).toBeNull();
        expect(await resolveNotificationPermissionTarget('https://unsaved.example.test')).toBeNull();
        await TokenStorage.setCredentials({ token: token('   ') });
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('does not send older notifications lacking occurrence identity', async () => {
        const old = response();
        const { occurrenceId: _occurrenceId, ...data } = old.notification.request.content.data;
        const legacy = { ...old, notification: { request: { ...old.notification.request, content: { data } } } };
        await expect(handleNotificationBackgroundTask({ data: legacy })).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('does not downgrade an unsupported occurrence response to the legacy method', async () => {
        boundary.rpc.mockResolvedValue({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE', error: 'Unsupported receiver' });
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'unconfirmed' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.rpc.mock.calls[0]?.[1]).toMatchObject({ method: 'session:session.permission.respondToOccurrence.v1' });
    });

    it('does not emit if the authenticated session endpoint denies access', async () => {
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => new Response('{}', { status: 404 }))));
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('keeps network acknowledgement failure unconfirmed and does not replay it', async () => {
        boundary.rpc.mockRejectedValue(new Error('ACK disconnected'));
        await expect(handleNotificationBackgroundTask({ data: response() })).resolves.toMatchObject({ status: 'unconfirmed' });
        await expect(executeNotificationPermissionAction(parsed(), { allowExecution: false })).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.disconnect).toHaveBeenCalledTimes(1);
    });

    it('never emits when a scoped session lookup completes after the issuance deadline', async () => {
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        const sessionResponse = await fetch(`${serverUrl}/v2/sessions/session`);
        let release!: () => void;
        const stalled = new Promise<Response>((resolve) => { release = () => resolve(sessionResponse); });
        vi.stubGlobal('fetch', vi.fn(() => stalled));
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed());
            await vi.advanceTimersByTimeAsync(30_000);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.rpc).not.toHaveBeenCalled();
            // Cancellation is already known, so no late socket is opened.
            expect(boundary.disconnect).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it.each(['never', 'late'] as const)('closes the one-shot socket when native encryption completes %s after the deadline', async (completion) => {
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const nativeCrypto = await import('rn-encryption');
        const secret = new Uint8Array(32).fill(7);
        expect(await TokenStorage.setCredentials({ token: token(), secret: encodeBase64(secret, 'base64url') })).toBe(true);
        const encryption = await Encryption.create(secret);
        const body = await (await fetch(`${serverUrl}/v2/sessions/session`)).json();
        body.session.encryptionMode = 'e2ee';
        body.session.dataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(new Uint8Array(32).fill(8)), 'base64');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
        let finish!: (value: string) => void;
        // Stall only the native AES boundary; account/session/encryption/RPC logic stays real.
        const encrypt = vi.spyOn(nativeCrypto, 'encryptAsyncAES').mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed());
            await vi.advanceTimersByTimeAsync(0);
            expect(encrypt).toHaveBeenCalledTimes(1);
            expect(boundary.disconnect).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(30_000);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            expect(boundary.disconnect).toHaveBeenCalledTimes(1);
            if (completion === 'late') {
                finish('AAAA');
                await vi.advanceTimersByTimeAsync(0);
                expect(boundary.disconnect).toHaveBeenCalledTimes(1);
            }
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('disconnects an in-progress connection at the action deadline and ignores a late connect event', async () => {
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        const sessionResponse = await fetch(`${serverUrl}/v2/sessions/session`);
        let release!: () => void;
        const lookup = new Promise<Response>((resolve) => { release = () => resolve(sessionResponse); });
        vi.stubGlobal('fetch', vi.fn(() => lookup));
        boundary.connectsImmediately = false;
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed());
            await vi.advanceTimersByTimeAsync(5000);
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.connect).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(25_000);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            // The connection's own 30s timeout is still five seconds away.
            expect(boundary.disconnect).toHaveBeenCalledTimes(1);
            boundary.completeConnection?.();
            await vi.advanceTimersByTimeAsync(5000);
            expect(boundary.rpc).not.toHaveBeenCalled();
            expect(boundary.disconnect).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });

    it('bounds a stalled target import without issuing after it resolves late', async () => {
        const target = await import('./resolveNotificationPermissionTarget');
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        let release!: () => void;
        const stalledTarget = new Promise<typeof target>((resolve) => { release = () => resolve(target); });
        // Stall only the bundle loader. Resolved modules retain real auth/storage/RPC behavior.
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed(), {
                importTarget: () => stalledTarget,
            });
            let settled = false;
            void pending.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(29_999);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('records a content-free recovery notice without a second asynchronous load', async () => {
        const { consumeNotificationPermissionRecoveryNeeded } = await import('./notificationPermissionRecovery');
        consumeNotificationPermissionRecoveryNeeded();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await expect(executeNotificationPermissionAction({ ...parsed(), permissionAction: null })).resolves.toMatchObject({ status: 'not_sent' });
            expect(boundary.rpc).not.toHaveBeenCalled();
            expect(consumeNotificationPermissionRecoveryNeeded()).toBe(true);
            expect(warn.mock.calls.flat().join(' ')).not.toContain(serverUrl);
        } finally { warn.mockRestore(); }
    });

    it('ignores receipts, malformed bodies and Open/Answer, and refuses malformed or unsaved permission targets', async () => {
        for (const body of [null, {}, { data: null }, { data: { notification: {} } }, { data: response('unknown') }, { data: response('expo.modules.notifications.actions.DEFAULT') }, { data: response(PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1) }]) {
            await expect(handleNotificationBackgroundTask(body)).resolves.toMatchObject({ status: 'ignored' });
        }
        await expect(executeNotificationPermissionAction({ ...parsed(), permissionAction: null })).resolves.toMatchObject({ status: 'not_sent' });
        await expect(executeNotificationPermissionAction({ ...parsed(), serverUrl: 'https://unsaved.example.test' })).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('decodes SDK54 task dataString and interprets application rejection inside transport success', async () => {
        boundary.rpc.mockResolvedValue({ ok: true, result: { ok: false, errorCode: 'permission_request_expired' } });
        const nativeResponse = { actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, notification: {
            request: { identifier: 'n1', content: { dataString: JSON.stringify(response().notification.request.content.data) } },
        } };
        await expect(handleNotificationBackgroundTask({ data: nativeResponse })).resolves.toMatchObject({ status: 'rejected' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
    });

    it('navigates to the session for a saved cold-start response without executing it', async () => {
        boundary.lastResponse = response();
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        await flushHookEffects();
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(boundary.navigate).toHaveBeenCalledTimes(1);
        expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
        expect(profiles.getActiveServerUrl()).toBe(serverUrl);
        await hook.unmount();
    });

    it('does not reopen a handled background action from the saved response cache', async () => {
        await expect(handleNotificationBackgroundTask({ data: response() })).resolves.toMatchObject({ status: 'confirmed' });
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        boundary.lastResponse = response();
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.push).not.toHaveBeenCalled();
        expect(profiles.getActiveServerUrl()).toBe(other.serverUrl);
        await hook.unmount();
    });

    it('still opens review for a newer occurrence reusing a native notification identifier', async () => {
        await handleNotificationBackgroundTask({ data: response() });
        const next = response();
        next.notification.request.content.data.occurrenceId = 'next-occurrence';
        boundary.lastResponse = next;
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.navigate).toHaveBeenCalledTimes(1);
        expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
        await hook.unmount();
    });

    it('keeps ordinary notification taps and Answer routed on Android and iOS', async () => {
        for (const platform of ['android', 'ios'] as const) {
            Platform.OS = platform;
            const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
            await act(async () => { boundary.listener?.(response('expo.modules.notifications.actions.DEFAULT', `${platform}-tap-${responseSequence}`)); });
            expect(boundary.navigate).toHaveBeenCalledTimes(1);
            expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
            boundary.navigate.mockClear();
            await act(async () => { boundary.listener?.(response(PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1, `${platform}-answer-${responseSequence}`)); });
            expect(boundary.navigate).toHaveBeenCalledTimes(1);
            expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
            boundary.navigate.mockClear();
            await hook.unmount();
        }
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it.each(['expo.modules.notifications.actions.DEFAULT', PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1])('keeps generated session navigation scoped to its notification server: %s', async (action) => {
        const target = profiles.getActiveServerSnapshot();
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await act(async () => {
                boundary.listener?.(response(action));
                profiles.setActiveServerId(other.id, { scope: 'device' });
            });
            expect(boundary.navigate).toHaveBeenCalledTimes(1);
            expectSessionNavigationToServer(target.serverId);
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('preserves an explicit arbitrary notification URL instead of replacing it with a session route', async () => {
        const current = response('expo.modules.notifications.actions.DEFAULT');
        const custom = { ...current, notification: { request: { ...current.notification.request, content: {
            data: { ...current.notification.request.content.data, url: '/settings/notifications?source=push' },
        } } } };
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await act(async () => { boundary.listener?.(custom); });
            expect(boundary.push).toHaveBeenCalledWith('/settings/notifications?source=push');
            expect(boundary.navigate).not.toHaveBeenCalled();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('keeps the explicit iOS notification server when Home changes before dispatch', async () => {
        Platform.OS = 'ios';
        const { storage } = await import('@/sync/domains/state/storage');
        const initialState = storage.getState();
        const target = profiles.getActiveServerSnapshot();
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        profiles.setActiveServerId(target.serverId, { scope: 'device' });
        // A notification can be the first session reference on this device.
        storage.setState({ sessions: {}, sessionListViewDataByServerId: {} });
        const originalFetch = fetch;
        const fetchBoundary = vi.fn<typeof fetch>(async (input, init) => {
            if (String(input).startsWith(`${other.serverUrl}/v2/sessions/`)) return new Response('{}', { status: 404 });
            return originalFetch(input, init);
        });
        vi.stubGlobal('fetch', fetchBoundary);
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            expect(boundary.listener).toEqual(expect.any(Function));
            await act(async () => {
                boundary.listener?.(response());
                // The real handler awaits loading/dispatch; Home can change in that interval.
                profiles.setActiveServerId(other.id, { scope: 'device' });
            });
            await vi.waitFor(() => expect(boundary.navigate).toHaveBeenCalledTimes(1));
            const sessionUrls = fetchBoundary.mock.calls.map(([input]) => new URL(String(input)))
                .filter((url) => url.pathname.startsWith('/v2/sessions/'))
                .map((url) => `${url.origin}${url.pathname}`);
            expect(sessionUrls).toEqual([`${serverUrl}/v2/sessions/session`]);
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            expectSessionNavigationToServer(target.serverId);
        } finally {
            await hook.unmount();
            storage.setState(initialState, true);
        }
    });

    it('keeps iOS cold-start permission buttons executable before navigating', async () => {
        Platform.OS = 'ios';
        boundary.lastResponse = response();
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await vi.waitFor(() => expect(boundary.navigate).toHaveBeenCalledTimes(1));
            expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            expect(boundary.lastResponse).toBeNull();
        } finally { await hook.unmount(); }
    });

    it('opens a legacy pending iOS action for scoped review and contains navigation failures', async () => {
        Platform.OS = 'ios';
        const { setPendingNotificationAction, getPendingNotificationAction } = await import('@/sync/domains/pending/pendingNotificationAction');
        setPendingNotificationAction({ serverUrl, sessionId: 'session', requestId: 'request', action: 'allow' });
        boundary.navigate.mockImplementationOnce(() => { throw new Error('navigation unavailable'); });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await flushHookEffects();
            expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
            expect(error).toHaveBeenCalled();
            expect(getPendingNotificationAction()).toBeNull();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('enforces a supplied account hint on the iOS notification path', async () => {
        Platform.OS = 'ios';
        const current = response();
        const hinted = { ...current, notification: { request: { ...current.notification.request, content: {
            data: { ...current.notification.request.content.data, accountId: 'another-account' },
        } } } };
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await act(async () => { boundary.listener?.(hinted); });
            await vi.waitFor(() => expect(boundary.navigate).toHaveBeenCalledTimes(1));
            expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it.each([PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1])('routes iOS legacy permission notifications to review and sends only occurrence-bound responses: %s', async (action) => {
        Platform.OS = 'ios';
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        const current = response(action, `ios-current-${responseSequence}`);
        const { occurrenceId: _occurrenceId, ...legacyData } = current.notification.request.content.data;
        const legacy = { ...current, notification: { request: {
            ...current.notification.request, identifier: `ios-legacy-${responseSequence}`, content: { data: legacyData },
        } } };
        await act(async () => { boundary.listener?.(legacy); });
        // Navigation follows the awaited permission branch, so this observes its
        // completion before making the negative assertion at the real socket boundary.
        await vi.waitFor(() => expect(boundary.navigate).toHaveBeenCalledTimes(1));
        expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
        expect(boundary.rpc).not.toHaveBeenCalled();

        // The same loaded hook and boundary must execute a current payload.
        await act(async () => { boundary.listener?.(current); });
        await vi.waitFor(() => expect(boundary.navigate).toHaveBeenCalledTimes(2));
        expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId, 1);
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.rpc.mock.calls[0]?.[1]).toMatchObject({
            method: 'session:session.permission.respondToOccurrence.v1',
            params: expect.objectContaining({ occurrenceId: current.notification.request.content.data.occurrenceId }),
        });
        expect(profiles.getActiveServerUrl()).toBe(serverUrl);
        await hook.unmount();
    });
});
