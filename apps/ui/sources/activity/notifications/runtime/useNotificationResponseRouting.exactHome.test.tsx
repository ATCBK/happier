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

// Network readiness is the system boundary for an address supplied by a notification.
const network = vi.hoisted(() => ({ healthy: false, serviceOnly: false, requests: [] as string[] }));
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: async (url: RequestInfo | URL) => {
        network.requests.push(String(url));
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
    },
}));

// Native notification module boundary: the test delivers responses through its listener.
const notifications = vi.hoisted(() => ({
    listener: null as ((response: unknown) => void) | null,
}));
vi.mock('@/utils/platform/loadExpoNotifications', () => ({
    loadExpoNotifications: async () => ({
        DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
        getLastNotificationResponseAsync: async () => null,
        addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
            notifications.listener = listener;
            return { remove: () => {
                if (notifications.listener === listener) notifications.listener = null;
            } };
        },
    }),
}));

// Session RPC transport boundary: records which Home each permission response targets.
const rpc = vi.hoisted(() => ({ calls: [] as Array<Readonly<{ serverId: string | undefined; method: string; payload: unknown }>> }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc')>()),
    sessionRpcWithServerScope: async (params: Readonly<{ serverId?: string; method: string; payload: unknown }>) => {
        rpc.calls.push({ serverId: params.serverId, method: params.method, payload: params.payload });
        return undefined;
    },
}));

// Connection-switch boundary: resolves without moving focus, so the dispatch happens
// while another Home is (still, or again) focused.
const switching = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/sync/domains/server/activeServerSwitch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/activeServerSwitch')>(),
    setActiveServerAndSwitch: async (params: Readonly<{ serverId: string }>) => {
        switching.calls.push(params.serverId);
        return 'switched';
    },
    upsertActivateAndSwitchServer: async () => 'blocked',
}));

// `@/sync/ops` pulls the Sync singleton only for unrelated operations.
vi.mock('@/sync/sync', () => ({ sync: {} }));

const SESSION_ID = 'same-session';
const REQUEST_ID = 'same-request';

// Compile the real routing graph during collection; cases still reset scoped native persistence.
await import('./useNotificationResponseRouting');

function permissionResponse(params: Readonly<{ serverId: string; serverUrl: string; identifier: string }>) {
    return {
        actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
        notification: {
            request: {
                identifier: params.identifier,
                content: {
                    data: {
                        serverId: params.serverId,
                        serverUrl: params.serverUrl,
                        sessionId: SESSION_ID,
                        requestId: REQUEST_ID,
                    },
                },
            },
        },
    };
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
    }
    expect(condition()).toBe(true);
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
async function mountRouting() {
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
    beforeEach(() => {
        vi.resetModules();
        notifications.listener = null;
        rpc.calls.length = 0;
        switching.calls.length = 0;
        pushSpy.mockClear();
        network.healthy = false;
        network.serviceOnly = false;
        network.requests.length = 0;
    });

    afterEach(async () => {
        await routingScreen?.unmount();
        routingScreen = null;
        vi.unstubAllEnvs();
    });

    it('sends Allow to the notification\'s focused Home, not to the Home a bare id resolves to', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);

        notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl, identifier: 'n-active' }));
        await waitFor(() => rpc.calls.length === 1);

        expect(rpc.calls[0]).toMatchObject({ serverId: homeA.id, payload: expect.objectContaining({ id: REQUEST_ID, approved: true }) });
    });

    it('sends Allow to the saved Home it switched to, even when another Home is focused at dispatch', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeB.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);

        notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl, identifier: 'n-saved' }));
        await waitFor(() => rpc.calls.length === 1);

        expect(switching.calls).toEqual([homeA.id]);
        expect(rpc.calls[0]!.serverId).toBe(homeA.id);
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
        expect(switching.calls).toEqual([homeA.id]);
        expect(pushSpy).toHaveBeenCalledWith(`/machines/machine%2Fa?serverId=${encodeURIComponent(homeA.id)}&tab=processes&sort=cpu`);
        expect(rpc.calls).toEqual([]);
    });

    it('replays a pending Allow against the Home it was recorded for', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        const { setPendingNotificationAction } = await import('@/sync/domains/pending/pendingNotificationAction');
        await setActiveServerId(homeA.id);
        setPendingNotificationAction({
            serverUrl: homeA.serverUrl,
            serverId: homeA.id,
            sessionId: SESSION_ID,
            requestId: REQUEST_ID,
            action: 'allow',
        });

        await mountRouting();
        await waitFor(() => rpc.calls.length === 1);

        expect(rpc.calls[0]!.serverId).toBe(homeA.id);
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
        expect(switching.calls).toEqual([connected!.id]);
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
            expect(switching.calls).toEqual([connected!.id]);
            expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(connected!.id)}`);
            expect(rpc.calls).toHaveLength(0);
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });
});
