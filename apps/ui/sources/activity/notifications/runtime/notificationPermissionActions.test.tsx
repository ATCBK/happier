import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { createServerFetchWithReachabilityProbe, renderHook, flushHookEffects } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { parseNotificationTap } from '../notificationRouting';
import { executeNotificationPermissionAction, handleNotificationBackgroundTask } from './notificationPermissionActions';
import { resolveNotificationPermissionTarget } from './resolveNotificationPermissionTarget';
import { initializeNotificationBackgroundTask, resetNotificationBackgroundTaskStateForTests } from './notificationBackgroundTaskState';
import { useNotificationResponseRouting } from './useNotificationResponseRouting';
import { notificationPermissionJournal } from './notificationPermissionJournal';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedSessionDataKeyCacheForTests, resolveScopedSessionCryptoContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { isServerReachabilityNetworkAllowed, resetServerReachabilitySupervisors, setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS } from '@/utils/platform/loadExpoNotifications';

const boundary = vi.hoisted(() => ({
    secrets: new Map<string, string>(),
    rpc: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    push: vi.fn(),
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
    return createExpoRouterMock({ router: { push: boundary.push } }).module;
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
function token(account = 'account') { return `e30.${btoa(JSON.stringify({ sub: account }))}.signature`; }
function response(actionIdentifier = PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1 as string, identifier: string | null = 'n1') {
    return { actionIdentifier, notification: { request: { identifier, content: { data: { serverUrl, sessionId: 'session', requestId: 'request' } } } } };
}
function parsed(value = response()) {
    const tap = parseNotificationTap({ response: value, defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
    if (!tap) throw new Error('Fixture did not parse');
    return tap;
}

describe('Android notification permission entry points', () => {
    beforeEach(async () => {
        Platform.OS = 'android';
        // Exercise production secure storage, not the development entitlement fallback.
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK', 'false');
        setServerReachabilityNetworkAllowed(true);
        boundary.secrets.clear();
        boundary.rpc.mockReset().mockResolvedValue({ ok: true, result: { ok: true } });
        boundary.push.mockClear();
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
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => new Response(JSON.stringify({
            session: { id: 'session', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                metadata: '{}', metadataVersion: 0, agentState: null, agentStateVersion: 0,
                pendingCount: 0, pendingVersion: 0, encryptionMode: 'plain', dataEncryptionKey: null },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))));
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

    it('deduplicates different or missing notification IDs by scoped request, including opposite actions', async () => {
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'confirmed' });
        await expect(handleNotificationBackgroundTask({ data: response(undefined, 'another') })).resolves.toMatchObject({ status: 'confirmed', duplicate: true });
        await expect(handleNotificationBackgroundTask({ data: response(undefined, null) })).resolves.toMatchObject({ status: 'confirmed', duplicate: true });
        await expect(executeNotificationPermissionAction(parsed(response(PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1)))).resolves.toMatchObject({ status: 'conflict' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
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
        expect(notificationPermissionJournal.read({ serverId: 'srv_notification_identity', accountId: 'account', sessionId: 'session', requestId: 'request', action: 'allow' })?.state).toBe('confirmed');
    });

    it('does not issue without credentials, rejects mismatched account hints, then allows an explicit retry', async () => {
        await TokenStorage.removeCredentials();
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
        await TokenStorage.setCredentials({ token: token('replacement') });
        await expect(executeNotificationPermissionAction({ ...parsed(), accountId: 'account' })).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
        await expect(executeNotificationPermissionAction(parsed(), { explicitRetry: true })).resolves.toMatchObject({ status: 'confirmed' });
    });

    it('fails closed for absent scope and invalid authentication', async () => {
        expect(await resolveNotificationPermissionTarget('not a URL')).toBeNull();
        expect(await resolveNotificationPermissionTarget('https://unsaved.example.test')).toBeNull();
        await TokenStorage.setCredentials({ token: token('   ') });
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('does not emit if the authenticated session endpoint denies access', async () => {
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => new Response('{}', { status: 404 }))));
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('keeps network acknowledgement failure unconfirmed and does not replay it', async () => {
        boundary.rpc.mockRejectedValue(new Error('ACK disconnected'));
        await expect(handleNotificationBackgroundTask({ data: response() })).resolves.toMatchObject({ status: 'unconfirmed' });
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'unconfirmed', duplicate: true });
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

    it.each(['target', 'journal'] as const)('bounds a stalled %s import without issuing after it resolves late', async (stage) => {
        const target = await import('./resolveNotificationPermissionTarget');
        const journal = await import('./notificationPermissionJournal');
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        let release!: () => void;
        const stalledTarget = stage === 'target'
            ? new Promise<typeof target>((resolve) => { release = () => resolve(target); })
            : Promise.resolve(target);
        const stalledJournal = stage === 'journal'
            ? new Promise<typeof journal>((resolve) => { release = () => resolve(journal); })
            : Promise.resolve(journal);
        // Stall only the bundle loader. Resolved modules retain real auth/storage/RPC behavior.
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed(), {
                importTarget: () => stalledTarget,
                importJournal: () => stalledJournal,
            });
            let settled = false;
            void pending.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(29_999);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1 + EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.rpc).not.toHaveBeenCalled();
            expect(notificationPermissionJournal.read({ serverId: 'srv_notification_identity', accountId: 'account', sessionId: 'session', requestId: 'request', action: 'allow' })).toBeNull();
        } finally { vi.useRealTimers(); }
    });

    it('settles recovery when its journal import never resolves and keeps the warning content-free', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const pending = executeNotificationPermissionAction({ ...parsed(), permissionAction: null }, {
                importJournal: () => new Promise<typeof import('./notificationPermissionJournal')>(() => {}),
            });
            let settled = false;
            void pending.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS - 1);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            expect(boundary.rpc).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith('[notifications] Permission action recovery storage unavailable');
            expect(warn.mock.calls.flat().join(' ')).not.toContain(serverUrl);
        } finally { vi.useRealTimers(); warn.mockRestore(); }
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

    it('does not execute a saved response on cold start', async () => {
        boundary.lastResponse = response();
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        await flushHookEffects();
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(boundary.push).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('keeps ordinary notification taps and Answer routed on Android and iOS', async () => {
        for (const platform of ['android', 'ios'] as const) {
            Platform.OS = platform;
            const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
            await act(async () => { boundary.listener?.(response('expo.modules.notifications.actions.DEFAULT')); });
            expect(boundary.push).toHaveBeenCalledWith('/session/session');
            boundary.push.mockClear();
            await act(async () => { boundary.listener?.(response(PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1)); });
            expect(boundary.push).toHaveBeenCalledWith('/session/session');
            await hook.unmount();
        }
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
});
