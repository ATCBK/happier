import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { MMKV } from 'react-native-mmkv';

import { renderScreen } from '@/dev/testkit';
import { scopedStorageId } from '@/utils/system/storageScope';
import { pendingServerScopedKey } from '@/sync/domains/pending/pendingServerScopedKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: pushSpy } }).module;
});

const pushSpy = vi.hoisted(() => vi.fn());

const network = { healthy: false, serviceOnly: false, requests: [] as string[] };
async function serveNotificationHttp(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        network.requests.push(String(url));
        if (rpcBoundary && servedHomeUrls.has(new URL(String(url)).origin)) return rpcBoundary.request(url, init);
        if (!network.healthy) return new Response('', { status: 503 });
        const path = String(url);
        if (path.endsWith('/health')) return new Response('{}', { status: 200 });
        if (path.endsWith('/v1/features')) {
            const { createRootLayoutFeaturesResponse, createSignInServiceFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
            if (network.serviceOnly) return new Response(JSON.stringify(createSignInServiceFeaturesResponse('https://unsaved.example.test')), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
            return new Response(JSON.stringify(createRootLayoutFeaturesResponse({
                capabilities: {
                    server: { canonicalServerUrl: 'https://unsaved.example.test' },
                    serverIdentity: { serverIdentityId: 'srv_verified_notification_home' },
                },
            })), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (path.endsWith('/v1/auth/entry')) return new Response('{}', { status: 404 });
        throw new Error(`Unexpected network request: ${path}`);
}


// Native notification module boundary: the test delivers responses through its listener.
const notifications = vi.hoisted(() => ({
    listener: null as ((response: unknown) => void) | null,
    lastResponse: null as unknown,
}));
vi.mock('@/utils/platform/loadExpoNotifications', () => ({
    loadExpoNotifications: async () => ({
        DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
        getLastNotificationResponseAsync: async () => notifications.lastResponse,
        addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
            notifications.listener = listener;
            return { remove: () => {
                if (notifications.listener === listener) notifications.listener = null;
            } };
        },
    }),
}));

// Observe serialized permission calls at Socket.IO; all internal owners remain real.
const rpc = { calls: [] as Array<Readonly<{ serverUrl: string; method: string; payload: unknown;
    token: string | undefined }>>, wait: null as Promise<void> | null };
let rpcBoundary: import('@/dev/testkit/harness/sessionOpsNetworkBoundary').SessionOpsNetworkBoundary | null = null;
const servedHomeUrls = new Set<string>();
const servedHomeTokens = new Map<string, string>();
let syncBridge: Awaited<ReturnType<typeof import('@/dev/testkit/harness/syncSingletonLoader').loadSyncSingletonForTests>> | null = null;

const SESSION_ID = 'same-session';
const REQUEST_ID = 'same-request';

// Load the real graph once outside test deadlines, after installing its SDK boundaries.
const { installSessionOpsNetworkBoundary } = await import('@/dev/testkit/harness/sessionOpsNetworkBoundary');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const initialNetwork = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
await import('./useNotificationResponseRouting');
await initialNetwork.dispose();

function permissionResponse(params: Readonly<{ serverId?: string; serverUrl: string; identifier: string; turnId?: string; accountId?: string; actionIdentifier?: string }>) {
    return {
        actionIdentifier: params.actionIdentifier ?? PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
        notification: {
            request: {
                identifier: params.identifier,
                content: {
                    data: {
                        ...(params.serverId ? { serverId: params.serverId } : {}),
                        serverUrl: params.serverUrl,
                        sessionId: SESSION_ID,
                        requestId: REQUEST_ID,
                        ...(params.turnId ? { turnId: params.turnId } : {}),
                        ...(params.accountId ? { accountId: params.accountId } : {}),
                    },
                },
            },
        },
    };
}

async function installNotificationRpcBoundary() {
        rpcBoundary = await installSessionOpsNetworkBoundary();
        const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        rpcBoundary.setHttpResponder(async input => {
            const url = new URL(String(input));
            if (url.pathname === `/v1/sessions/${SESSION_ID}` || url.pathname === `/v2/sessions/${SESSION_ID}`) {
                return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id: SESSION_ID })));
            }
            return null;
        });
        rpcBoundary.setRpcResponder(async request => {
            if (request.method !== 'session.permission.respond') return undefined;
            rpc.calls.push({ serverUrl: request.serverUrl, method: request.method, payload: request.payload,
                token: request.token });
            await rpc.wait;
            return undefined;
        });
}

async function saveNotificationAccount(home: Readonly<{ id: string; serverUrl: string }>) {
    const added = await rpcBoundary!.addHome(home.serverUrl, 'notification-account');
    servedHomeTokens.set(home.serverUrl, added.token);
    servedHomeUrls.add(home.serverUrl);
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(serveNotificationHttp);
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
    }
    expect(condition(), JSON.stringify({ rpc: rpcBoundary?.requests, http: rpcBoundary?.httpRequests })).toBe(true);
}

async function setupHomes() {
    const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    const { storage } = await import('@/sync/domains/state/storage');
    const homeA = await upsertServerProfile({ serverUrl: 'https://home-a.example.test', name: 'Home A', source: 'manual' });
    const homeB = await upsertServerProfile({ serverUrl: 'https://home-b.example.test', name: 'Home B', source: 'manual' });
    // The same Session id is also a listed Session on Home B: local evidence that
    // points the bare id at B, as the list owner produces for a duplicate id.
    storage.setState((state) => ({
        ...state,
        ordinarySessionListMembershipByServerId: {
            ...state.ordinarySessionListMembershipByServerId,
            [homeB.id]: [SESSION_ID],
        },
    }));
    return { homeA, homeB, setActiveServerId };
}

let routingScreen: Awaited<ReturnType<typeof renderScreen>> | null = null;
async function prepareNotificationRuntime() {
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(serveNotificationHttp);
    syncBridge = await loadSyncSingletonForTests();
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const active = getActiveServerSnapshot();
    const credentials = await TokenStorage.getCredentialsForServerUrl(active.serverUrl, { serverId: active.serverId });
    if (credentials) {
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer(credentials);
    }
}

async function mountRouting() {
    await prepareNotificationRuntime();
    const { useNotificationResponseRouting } = await import('./useNotificationResponseRouting');
    function Probe() {
        useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} });
        return null;
    }
    routingScreen = await renderScreen(React.createElement(Probe));
}

function disableConfiguredHomeSeeds(): void {
    // A native default build seeds Happier Cloud. These cases exercise the supported
    // serverless build policy, through its environment boundary rather than a profile mock.
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_URL', '');
    vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', '');
    vi.stubEnv('EXPO_PUBLIC_SERVER_URL', '');
    vi.stubEnv('EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS', '[]');
    const denied = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', [denied, 'setup.relay.allowHappierCloud'].filter(Boolean).join(','));
}

describe('useNotificationResponseRouting exact-Home permission dispatch', () => {
    beforeEach(async () => {
        vi.resetModules();
        notifications.listener = null;
        notifications.lastResponse = null;
        rpc.wait = null;
        rpc.calls.length = 0;
        pushSpy.mockClear();
        network.healthy = false;
        network.serviceOnly = false;
        network.requests.length = 0;
        await installNotificationRpcBoundary();
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(serveNotificationHttp);
    });

    afterEach(async () => {
        await routingScreen?.unmount();
        routingScreen = null;
        if (syncBridge) {
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        }
        await rpcBoundary?.dispose();
        rpcBoundary = null;
        servedHomeUrls.clear();
        servedHomeTokens.clear();
        syncBridge?.dispose();
        syncBridge = null;
        vi.unstubAllEnvs();
    });

    it('requires review for an Android legacy permission action without switching Home or navigating', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        const { Platform } = await import('react-native');
        Platform.OS = 'android';
        try {
            await setActiveServerId(homeB.id);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            await act(async () => {
                notifications.listener!(permissionResponse({ serverId: homeA.id,
                    serverUrl: homeA.serverUrl, identifier: 'android-legacy-action' }));
            });
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
            expect(rpc.calls).toEqual([]);
            expect(pushSpy).not.toHaveBeenCalled();
        } finally {
            Platform.OS = 'ios';
        }
    });

    it('coalesces live Android decisions on their exact saved Account without switching or navigating', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        const { Platform } = await import('react-native');
        await saveNotificationAccount(homeA);
        let release: (() => void) | undefined;
        rpc.wait = new Promise<void>(resolve => { release = resolve; });
        Platform.OS = 'android';
        try {
            await setActiveServerId(homeB.id);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            const response = permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
                identifier: 'android-bound-action', turnId: 'bound-turn', accountId: 'notification-account' });
            await act(async () => {
                notifications.listener!(response);
                notifications.listener!({ ...response, notification: { ...response.notification,
                    request: { ...response.notification.request, identifier: 'another-delivery' } } });
            });
            await waitFor(() => rpc.calls.length === 1);
            expect(rpc.calls[0]).toMatchObject({ serverUrl: homeA.serverUrl, token: servedHomeTokens.get(homeA.serverUrl),
                payload: { id: REQUEST_ID, turnId: 'bound-turn', approved: true } });
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
            expect(pushSpy).not.toHaveBeenCalled();
            release?.();
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
            // Expo's task and listener are independently scheduled: a second
            // execution may arrive after the real first ACK and socket cleanup.
            const { parseNotificationTap } = await import('../notificationRouting');
            const { executeNotificationPermissionAction } = await import('./notificationPermissionActions');
            const repeated = parseNotificationTap({ response,
                defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
            if (!repeated) throw new Error('Expected the original permission response');
            await expect(executeNotificationPermissionAction(repeated)).resolves.toEqual({ status: 'confirmed' });
            await act(async () => {
                notifications.listener!(response);
                await new Promise(resolve => setImmediate(resolve));
            });
            expect(rpc.calls).toHaveLength(1);
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
            expect(pushSpy).not.toHaveBeenCalled();
            await routingScreen?.unmount();
            routingScreen = null;
            notifications.lastResponse = response;
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
            expect(rpc.calls).toHaveLength(1);
            expect(pushSpy).not.toHaveBeenCalled();
            const conflict = parseNotificationTap({ response: { ...response,
                actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1 },
                defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
            if (!conflict) throw new Error('Expected the opposing permission response');
            await expect(executeNotificationPermissionAction(conflict)).resolves.toEqual({ status: 'conflict' });
            expect(rpc.calls).toHaveLength(1);
            const nextTurn = parseNotificationTap({ response: permissionResponse({
                serverId: homeA.id, serverUrl: homeA.serverUrl, identifier: 'next-turn-action',
                turnId: 'next-bound-turn', accountId: 'notification-account',
            }), defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
            if (!nextTurn) throw new Error('Expected the next bound permission response');
            await expect(executeNotificationPermissionAction(nextTurn)).resolves.toEqual({ status: 'confirmed' });
            expect(rpc.calls).toHaveLength(2);
            expect(rpc.calls[1]).toMatchObject({ serverUrl: homeA.serverUrl,
                token: servedHomeTokens.get(homeA.serverUrl), payload: { id: REQUEST_ID, turnId: 'next-bound-turn', approved: true } });
            expect(pushSpy).not.toHaveBeenCalled();
        } finally {
            release?.();
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
            Platform.OS = 'ios';
        }
    });

    it('opens an unhandled cached Android permission response for review without answering it', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        const { Platform } = await import('react-native');
        Platform.OS = 'android';
        try {
            await setActiveServerId(homeB.id);
            notifications.lastResponse = permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
                identifier: 'cached-android-action', turnId: 'old-turn' });
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            await waitFor(() => pushSpy.mock.calls.length > 0);
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeA.id);
            expect(rpc.calls).toEqual([]);
            expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        } finally {
            Platform.OS = 'ios';
        }
    });

    it.each([PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1])(
        'opens an iOS legacy button %s for review without answering', async (actionIdentifier) => {
            const { homeA, setActiveServerId } = await setupHomes();
            await setActiveServerId(homeA.id);
            await saveNotificationAccount(homeA);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
                identifier: `ios-legacy-${actionIdentifier}`, actionIdentifier }));
            await waitFor(() => pushSpy.mock.calls.length === 1);
            expect(rpc.calls).toEqual([]);
        });

    it('keeps an iOS notification bound to turn A when request id has loaded turn B', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await saveNotificationAccount(homeA);
        const { storage } = await import('@/sync/domains/state/storage');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        storage.getState().applySessions([createSessionFixture({ id: SESSION_ID, serverId: homeA.id,
            agentState: { requests: { [REQUEST_ID]: { tool: 'Write', arguments: {}, turnId: 'turn-b' } } },
        })]);
        notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
            identifier: 'ios-bound-turn-a', turnId: 'turn-a', accountId: 'notification-account' }));
        await waitFor(() => rpc.calls.length === 1);
        expect(rpc.calls[0]).toMatchObject({ serverUrl: homeA.serverUrl, token: servedHomeTokens.get(homeA.serverUrl),
            payload: { id: REQUEST_ID, turnId: 'turn-a', approved: true } });
        await waitFor(() => pushSpy.mock.calls.length === 1);
    });

    it('keeps a URL-only permission route on its admitted Home after the ACK and focus change', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await saveNotificationAccount(homeA);
        let release: (() => void) | undefined;
        rpc.wait = new Promise<void>(resolve => { release = resolve; });
        try {
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            notifications.listener!(permissionResponse({ serverUrl: homeA.serverUrl,
                identifier: 'url-only-delayed-permission', turnId: 'url-only-original-turn', accountId: 'notification-account' }));
            await waitFor(() => rpc.calls.length === 1);
            expect(pushSpy).not.toHaveBeenCalled();
            const { setActiveServerAndSwitch } = await import('@/sync/domains/server/activeServerSwitch');
            await expect(setActiveServerAndSwitch({ serverId: homeB.id })).resolves.toBe('switched');
            const { storage } = await import('@/sync/domains/state/storage');
            storage.setState(state => ({ ordinarySessionListMembershipByServerId: {
                ...state.ordinarySessionListMembershipByServerId, [homeB.id]: [SESSION_ID],
            } }));
            release?.();
            await waitFor(() => pushSpy.mock.calls.length === 1);
            expect(rpc.calls).toMatchObject([{ serverUrl: homeA.serverUrl, token: servedHomeTokens.get(homeA.serverUrl),
                payload: { id: REQUEST_ID, turnId: 'url-only-original-turn', approved: true } }]);
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
            expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        } finally {
            release?.();
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
        }
    });

    it.each([
        { entry: 'legacy permission button', actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, cached: false },
        { entry: 'notification body', actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', cached: false },
        { entry: 'Answer button', actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1, cached: false },
        { entry: 'cached Android permission button', actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, cached: true },
    ])('keeps the admitted Home in a URL-only $entry route without answering', async ({ entry, actionIdentifier, cached }) => {
        const { homeA, setActiveServerId } = await setupHomes();
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        Platform.OS = cached ? 'android' : 'ios';
        try {
            await setActiveServerId(homeA.id);
            await saveNotificationAccount(homeA);
            const response = permissionResponse({ serverUrl: homeA.serverUrl, identifier: `url-only-${entry}`, actionIdentifier });
            if (cached) notifications.lastResponse = response;
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            if (!cached) notifications.listener!(response);
            await waitFor(() => pushSpy.mock.calls.length === 1);
            expect(rpc.calls).toEqual([]);
            expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        } finally {
            Platform.OS = previousPlatform;
        }
    });

    it('sends Allow to the notification\'s focused Home, not to the Home a bare id resolves to', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);

        await saveNotificationAccount(homeA);
        notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl, identifier: 'n-active', turnId: 'turn-active' }));
        await waitFor(() => rpc.calls.length === 1);

        expect(rpc.calls[0]).toMatchObject({ serverUrl: homeA.serverUrl, payload: expect.objectContaining({ id: REQUEST_ID, approved: true }) });
    });

    it('sends Allow to the saved Home it switched to, even when another Home is focused at dispatch', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeB.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);

        await saveNotificationAccount(homeA);
        notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl, identifier: 'n-saved', turnId: 'turn-saved' }));
        await waitFor(() => rpc.calls.length === 1);

        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeA.id);
        expect(rpc.calls[0]!.serverUrl).toBe(homeA.serverUrl);
    });

    it('opens a machine vitals notice on its verified saved Home without inventing a Session action', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeB.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        notifications.listener!({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { request: {
            identifier: 'machine-saved', content: { data: { topic: 'resource_limit', kind: 'cpu_busy', phase: 'started', machineId: 'machine/a',
                notificationId: 'notice', nextSteps: ['review_processes'], serverId: homeA.id, serverUrl: homeA.serverUrl } },
        } } });
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeA.id);
        expect(pushSpy).toHaveBeenCalledWith(`/machines/machine%2Fa?serverId=${encodeURIComponent(homeA.id)}&tab=processes&sort=cpu`);
        expect(rpc.calls).toEqual([]);
    });

    it('opens an old pending Allow for review without replaying its decision', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        const { setPendingNotificationAction } = await import('@/sync/domains/pending/pendingNotificationAction');
        await setActiveServerId(homeA.id);
        await saveNotificationAccount(homeA);
        await prepareNotificationRuntime();
        setPendingNotificationAction({
            serverUrl: homeA.serverUrl,
            serverId: homeA.id,
            sessionId: SESSION_ID,
            requestId: REQUEST_ID,
            action: 'allow',
        });

        await mountRouting();
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(rpc.calls).toEqual([]);
    });

    it('does not route or act on an unsaved Home when its notification address is unreachable', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `notification_connect_${Date.now()}`;
        try {
            disableConfiguredHomeSeeds();
            vi.resetModules();
            const { listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
            expect(listServerProfiles()).toHaveLength(0);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);

            notifications.listener!(permissionResponse({
                serverId: 'unsaved-home',
                serverUrl: 'https://unsaved.example.test',
                identifier: 'n-unsaved',
            }));
            await waitFor(() => network.requests.some((url) => url.endsWith('/health')));

            expect(pushSpy).not.toHaveBeenCalled();
            expect(rpc.calls).toHaveLength(0);
            expect(listServerProfiles()).toHaveLength(0);
            const pendingStorage = new MMKV({ id: scopedStorageId('pending-notification-nav', process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE) });
            const pendingKey = pendingServerScopedKey('record:server:v1', 'https://unsaved.example.test');
            expect(JSON.parse(pendingStorage.getString(pendingKey)!)).toMatchObject({
                serverUrl: 'https://unsaved.example.test',
            });
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('opens the Add Home draft with an unknown notification address when other Homes are saved', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);

        notifications.listener!(permissionResponse({
            serverId: 'unknown-home',
            serverUrl: 'https://new-home.example.test',
            identifier: 'n-new-home',
        }));

        expect(pushSpy).toHaveBeenCalledWith(
            '/settings/server/add?address=https%3A%2F%2Fnew-home.example.test&source=notification',
        );
        expect(rpc.calls).toHaveLength(0);

        const pendingStorage = new MMKV({ id: scopedStorageId('pending-notification-nav', process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE ?? null) });
        const pendingKey = pendingServerScopedKey('record:server:v1', 'https://new-home.example.test');
        const pending = pendingStorage.getString(pendingKey);
        expect(JSON.parse(pending!)).toMatchObject({ serverUrl: 'https://new-home.example.test' });

        // Completing the separate draft at its canonical URL does not transfer the
        // notification's entered-address custody or automatically replay its route.
        network.healthy = true;
        const { connectHomeAtAddress } = await import('@/sync/ops/home/connectHomeAtAddress');
        const connected = await connectHomeAtAddress({
            serverUrl: 'https://new-home.example.test',
            source: 'notification',
            confirmInsecureHttp: async () => true,
            confirmCanonicalUrl: async () => true,
        });
        expect(connected.kind).toBe('connected');
        if (connected.kind !== 'connected') throw new Error('Expected the draft Home to connect');
        expect(connected.profile.serverUrl).toBe('https://unsaved.example.test');
        await setActiveServerId(connected.profile.id);
        pushSpy.mockClear();
        await mountRouting();
        expect(pushSpy).not.toHaveBeenCalled();
        expect(rpc.calls).toHaveLength(0);
        expect(pendingStorage.getString(pendingKey)).toBe(pending);
    });

    it('adopts a Directory-capable notification Home without selecting a service or replaying Allow', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `notification_service_${Date.now()}`);
        disableConfiguredHomeSeeds();
        vi.resetModules();
        network.healthy = true;
        network.serviceOnly = true;
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const beforeService = profiles.resolveSelectedAccountServiceEndpoint();
        expect(profiles.listServerProfiles()).toHaveLength(0);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        notifications.listener!(permissionResponse({ serverId: 'unverified-id', serverUrl: 'https://unsaved.example.test', identifier: 'n-service' }));
        await waitFor(() => pushSpy.mock.calls.length > 0);
        const [connected] = profiles.listServerProfiles();
        expect(connected?.serverUrl).toBe('https://unsaved.example.test');
        expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(connected!.id)}`);
        expect(profiles.resolveSelectedAccountServiceEndpoint()).toEqual(beforeService);
        expect(rpc.calls).toHaveLength(0);
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe('srv_accounts_entry');
        const pendingStorage = new MMKV({ id: scopedStorageId('pending-notification-nav', process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE ?? null) });
        const key = pendingServerScopedKey('record:server:v1', 'https://unsaved.example.test');
        expect(pendingStorage.getString(key)).toBeUndefined();
    });

    it('routes a connected notification to its verified Home, not the supplied unknown id', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `notification_connected_${Date.now()}`;
        try {
            disableConfiguredHomeSeeds();
            vi.resetModules();
            network.healthy = true;
            const { listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
            expect(listServerProfiles()).toHaveLength(0);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);

            notifications.listener!(permissionResponse({
                serverId: 'unverified-notification-id',
                serverUrl: 'https://unsaved.example.test',
                identifier: 'n-connected',
            }));
            await waitFor(() => pushSpy.mock.calls.length > 0);

            const [connected] = listServerProfiles();
            expect(connected).toBeDefined();
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe('srv_verified_notification_home');
            expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(connected!.id)}`);
            expect(rpc.calls).toHaveLength(0);
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });
});
