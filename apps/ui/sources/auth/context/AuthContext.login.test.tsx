import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { settingsParse } from '@/sync/domains/settings/settings';
import { AuthProvider, getCurrentAuth } from './AuthContext';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const secureStore = vi.hoisted(() => new Map<string, string>());
const secureStoreRead = vi.hoisted(() => ({ beforeRead: null as ((key: string) => Promise<void>) | null }));
const syncSwitchServerSpy = vi.hoisted(() =>
    vi.fn((credentials: { token: string; secret: string } | null) => {
        if (!credentials) return Promise.resolve();
        return new Promise<void>(() => {});
    }),
);
const switchConnectionToActiveServerSpy = vi.hoisted(() => vi.fn(
    async (): Promise<{ token: string; secret?: string } | null> => null,
));
const activeServerSnapshotState = vi.hoisted(() => ({
    serverId: '',
    serverUrl: '',
    generation: 0,
    connectionDescriptorRevision: undefined as number | undefined,
}));
const nextServerSequenceState = vi.hoisted(() => ({ value: 0 }));
const serverProfilesState = vi.hoisted(() => ({
    profiles: [] as Array<{ id: string; serverUrl: string; name: string; serverIdentityId?: string }>,
}));
// Hoisted: the voice binding store subscribes while the static imports load.
const activeServerListenerState = vi.hoisted(() => ({
    current: null as ((snapshot: {
        serverId: string;
        serverUrl: string;
        generation: number;
        connectionDescriptorRevision?: number;
    }) => void) | null,
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => {
        await secureStoreRead.beforeRead?.(key);
        return secureStore.get(key) ?? null;
    },
    setItemAsync: async (key: string, value: string) => {
        secureStore.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
        secureStore.delete(key);
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

vi.mock('@/track', () => ({
    trackLogout: vi.fn(),
    initializeTracking: vi.fn(),
    tracking: null,
}));

vi.mock('@/sync/sync', () => ({
    syncSwitchServer: syncSwitchServerSpy,
}));

// Network boundary: these tests own AuthContext credential/focus behavior, not
// reachability supervision. Fake timers would otherwise park the supervisor's
// probe loop indefinitely before the injected fetch boundary is reached.
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: async ({
        url,
        init,
    }: Readonly<{ url: string; init: RequestInit }>) => await fetch(url, init),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>(),
    switchConnectionToActiveServer: switchConnectionToActiveServerSpy,
    getAppliedActiveServerId: () => activeServerSnapshotState.serverId,
    subscribeAppliedActiveServer: () => () => {},
    subscribeApplyingActiveServer: () => () => {},
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ ...activeServerSnapshotState }),
    upsertAndActivateServer: ({ serverUrl }: { serverUrl: string }) => {
        nextServerSequenceState.value += 1;
        activeServerSnapshotState.serverId = `server-${nextServerSequenceState.value}`;
        activeServerSnapshotState.serverUrl = serverUrl;
        activeServerSnapshotState.generation += 1;
        const profile = {
            id: activeServerSnapshotState.serverId,
            serverUrl,
            name: serverUrl,
        };
        // Activation also registers the Home: implicit and exact credential
        // lookups must resolve the same scope, as they do in the real owner.
        serverProfilesState.profiles.push(profile);
        return profile;
    },
    subscribeActiveServer: (listener: unknown) => {
        // AuthProvider and the concurrent secondary-Home runtime both subscribe.
        // These tests drive the first (AuthContext) subscriber explicitly.
        activeServerListenerState.current ??= listener as typeof activeServerListenerState.current;
        return () => {
            if (activeServerListenerState.current === listener) {
                activeServerListenerState.current = null;
            }
        };
    },
}));
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    getActiveServerId: () => activeServerSnapshotState.serverId,
    getActiveServerUrl: () => activeServerSnapshotState.serverUrl,
    listServerProfiles: () => serverProfilesState.profiles,
}));

function buildTokenWithSub(sub: string): string {
    const payload = Buffer.from(JSON.stringify({ sub })).toString('base64');
    return `hdr.${payload}.sig`;
}

describe('AuthContext.login', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        secureStore.clear();
        secureStoreRead.beforeRead = null;
        activeServerListenerState.current = null;
        activeServerSnapshotState.serverId = '';
        activeServerSnapshotState.serverUrl = '';
        activeServerSnapshotState.generation = 0;
        activeServerSnapshotState.connectionDescriptorRevision = undefined;
        nextServerSequenceState.value = 0;
        serverProfilesState.profiles = [];
        syncSwitchServerSpy.mockClear();
        switchConnectionToActiveServerSpy.mockReset();
        switchConnectionToActiveServerSpy.mockResolvedValue(null);
    });

    afterEach(() => {
        secureStoreRead.beforeRead = null;
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('keeps the session authenticated while a login-triggered server refresh is still rebinding credentials', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const previousState = storage.getState();
        storage.getState().applyLocalSettings({ hasCompletedAuthOnce: false }, { source: 'test' });
        storage.setState(state => ({ settings: settingsParse({ ...state.settings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }) }));
        switchConnectionToActiveServerSpy.mockImplementation(
            () => new Promise<null>(() => {}),
        );
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });


        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: null,
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            await vi.waitFor(() => {
                expect(activeServerListenerState.current).toBeTypeOf('function');
            });

            const loginPromise = act(async () => {
                await auth.login(buildTokenWithSub('server-test'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
            });
            await loginPromise;

            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            expect(storage.getState().localSettings.hasCompletedAuthOnce).toBe(true);

            await act(async () => {
                activeServerListenerState.current?.({
                    serverId: 'server-test',
                    serverUrl: 'http://localhost:53288',
                    generation: 1,
                });
            });

            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
        } finally {
            await screen.unmount();
            storage.setState(previousState, true);
        }
    });

    it('stores an exact-target Home credential without replacing the newly focused Home auth projection', async () => {
        const homeA = {
            id: 'home-a',
            serverUrl: 'https://home-a.example.test',
            name: 'Home A',
            serverIdentityId: 'srv_home_a',
        };
        const homeB = {
            id: 'home-b',
            serverUrl: 'https://home-b.example.test',
            name: 'Home B',
            serverIdentityId: 'srv_home_b',
        };
        serverProfilesState.profiles = [homeA, homeB];
        activeServerSnapshotState.serverId = homeB.serverIdentityId;
        activeServerSnapshotState.serverUrl = homeB.serverUrl;
        activeServerSnapshotState.generation = 2;
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        const homeBCredentials = { token: buildTokenWithSub('home-b') };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentialsForServerUrl(
            homeB.serverUrl,
            { serverId: homeB.serverIdentityId },
            homeBCredentials,
        );
        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: homeBCredentials,
            children: React.createElement(React.Fragment, null),
        }));

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            await expect(auth.loginWithCredentials(homeACredentials, {
                target: {
                    serverUrl: homeA.serverUrl,
                    serverId: homeA.serverIdentityId,
                },
            })).resolves.toEqual({ kind: 'completed' });

            await expect(TokenStorage.getCredentialsForServerUrl(
                homeA.serverUrl,
                { serverId: homeA.serverIdentityId },
            )).resolves.toEqual(homeACredentials);
            expect(getCurrentAuth()).toMatchObject({
                isAuthenticated: true,
                credentials: homeBCredentials,
            });
            expect(switchConnectionToActiveServerSpy).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
        }
    });

    it('does not publish exact-target credentials after focus changes while suppression clears', async () => {
        const homeA = {
            id: 'home-a',
            serverUrl: 'https://home-a.example.test',
            name: 'Home A',
            serverIdentityId: 'srv_home_a',
        };
        const homeB = {
            id: 'home-b',
            serverUrl: 'https://home-b.example.test',
            name: 'Home B',
            serverIdentityId: 'srv_home_b',
        };
        serverProfilesState.profiles = [homeA, homeB];
        activeServerSnapshotState.serverId = homeA.serverIdentityId;
        activeServerSnapshotState.serverUrl = homeA.serverUrl;
        activeServerSnapshotState.generation = 1;
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        let releaseSuppression!: () => void;
        const suppressionGate = new Promise<boolean>((resolve) => {
            releaseSuppression = () => resolve(true);
        });
        const suppressionSpy = vi
            .spyOn(TokenStorage, 'setAuthAutoRedirectSuppressedUntil')
            .mockImplementation(async () => {
                activeServerSnapshotState.serverId = homeB.serverIdentityId;
                activeServerSnapshotState.serverUrl = homeB.serverUrl;
                activeServerSnapshotState.generation = 2;
                activeServerListenerState.current?.({
                    serverId: homeB.serverIdentityId,
                    serverUrl: homeB.serverUrl,
                    generation: 2,
                });
                return await suppressionGate;
            });

        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: null,
            children: React.createElement(React.Fragment, null),
        }));

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            let loginPromise!: Promise<unknown>;
            let switchCallsWhileFocusChanged = 0;
            await act(async () => {
                loginPromise = auth.loginWithCredentials(homeACredentials, {
                    target: {
                        serverUrl: homeA.serverUrl,
                        serverId: homeA.serverIdentityId,
                    },
                });
                await vi.waitFor(() => expect(suppressionSpy).toHaveBeenCalledTimes(1));
                switchCallsWhileFocusChanged = switchConnectionToActiveServerSpy.mock.calls.length;
                releaseSuppression();
                await expect(loginPromise).resolves.toEqual({ kind: 'completed' });
            });

            await expect(TokenStorage.getCredentialsForServerUrl(
                homeA.serverUrl,
                { serverId: homeA.serverIdentityId },
            )).resolves.toEqual(homeACredentials);
            expect(getCurrentAuth()).toMatchObject({
                isAuthenticated: false,
                credentials: null,
            });
            expect(switchConnectionToActiveServerSpy).toHaveBeenCalledTimes(switchCallsWhileFocusChanged);
        } finally {
            suppressionSpy.mockRestore();
            await screen.unmount();
        }
    });

    it('clears stale auth state when the active server changes during a login-triggered rebind', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });


        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: null,
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            await vi.waitFor(() => {
                expect(activeServerListenerState.current).toBeTypeOf('function');
            });

            await act(async () => {
                await auth.login(buildTokenWithSub('server-test'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
            });

            expect(getCurrentAuth()?.isAuthenticated).toBe(true);

            upsertAndActivateServer({ serverUrl: 'http://localhost:59876', scope: 'tab' });
            await act(async () => {
                await auth.refreshFromActiveServer();
            });

            expect(switchConnectionToActiveServerSpy).toHaveBeenCalled();
            expect(getCurrentAuth()?.isAuthenticated).toBe(false);
            expect(getCurrentAuth()?.credentials).toBeNull();
        } finally {
            await screen.unmount();
        }
    });

    it('replaces persisted and in-memory E2EE credentials when confirmed Forget supplies discardHistoricalEncryption', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { default: tweetnacl } = await import('tweetnacl');
        const keyPair = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(7));
        const token = buildTokenWithSub('server-test');
        const initialCredentials = {
            token,
            encryption: {
                publicKey: encodeBase64(keyPair.publicKey, 'base64url'),
                machineKey: encodeBase64(keyPair.secretKey, 'base64url'),
            },
        };
        await TokenStorage.setCredentials(initialCredentials);
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials,
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            await act(async () => {
                await expect(auth.loginWithCredentials({ token }, { discardHistoricalEncryption: true }))
                    .resolves.toEqual({ kind: 'completed' });
            });

            expect(await TokenStorage.getCredentials()).toEqual({ token });
            expect(getCurrentAuth()?.credentials).toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            expect(switchConnectionToActiveServerSpy).toHaveBeenCalled();
        } finally {
            await screen.unmount();
        }
    });

    it('retains historical keys in persisted and in-memory credentials during same-Account refresh', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        const { encodeBase64 } = await import('@/encryption/base64');
        const initialCredentials = {
            token,
            secret: encodeBase64(new Uint8Array(32).fill(8), 'base64url'),
        };
        await TokenStorage.setCredentials(initialCredentials);
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials,
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            await act(async () => {
                await expect(auth.loginWithCredentials({ token }))
                    .resolves.toEqual({ kind: 'completed' });
            });

            expect(await TokenStorage.getCredentials()).toEqual(initialCredentials);
            expect(getCurrentAuth()?.credentials).toEqual(initialCredentials);
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            expect(switchConnectionToActiveServerSpy).toHaveBeenCalled();
            await act(async () => {
                await auth.loginWithCredentials({ token }, { discardHistoricalEncryption: true });
            });
            expect(await TokenStorage.getCredentials()).toEqual({ token });
            expect(getCurrentAuth()?.credentials).toEqual({ token });
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the mobile brand hero dismissed after logout', async () => {
        const seenAt = 1_789_222_000_000;
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
        const { clearPersistence, loadLocalSettings, saveLocalSettings } = await import('@/sync/domains/state/persistence');
        await clearPersistence();
        saveLocalSettings({
            ...localSettingsDefaults,
            brandHeroSeenAt: seenAt,
        });


        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token: buildTokenWithSub('server-test'), secret: 'secret-test' },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            await act(async () => {
                await auth.logout();
            });

            expect(loadLocalSettings().brandHeroSeenAt).toBe(seenAt);
            expect(switchConnectionToActiveServerSpy).toHaveBeenCalledTimes(1);
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: false, credentials: null });
        } finally {
            await screen.unmount();
            await clearPersistence();
        }
    });

    it('runs the authorized pre-mutation callback immediately before destructive logout', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        await TokenStorage.setCredentials({ token });
        const { trackLogout } = await import('@/track');
        const beforeMutation = vi.fn();
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            let result;
            await act(async () => {
                result = await auth.logout({
                    beforeMutation,
                });
            });
            expect(result).toEqual({
                kind: 'completed',
            });

            expect(beforeMutation).toHaveBeenCalledTimes(1);
            expect(trackLogout).toHaveBeenCalledTimes(1);
            expect(
                beforeMutation.mock.invocationCallOrder[0],
            ).toBeLessThan(
                vi.mocked(trackLogout).mock.invocationCallOrder[0]!,
            );
            expect(getCurrentAuth()?.isAuthenticated).toBe(false);
        } finally {
            await screen.unmount();
        }
    });

    it('blocks logout before any auth mutation while marked first-key custody is active', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        // An active Home is always a saved Home: the real upsert saves it, so the
        // focused logout's exact-Home custody read and the active-Home custody
        // writer resolve one storage scope. The runtime stub only moves focus.
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const savedHome = await upsertServerProfile({ serverUrl: 'http://localhost:53288', name: 'Home' });
        serverProfilesState.profiles = [{ id: savedHome.id, serverUrl: savedHome.serverUrl, name: savedHome.name }];
        activeServerSnapshotState.serverId = savedHome.id;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        await TokenStorage.setCredentials({ token });
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            serverId: activeServerSnapshotState.serverId,
            serverUrl: activeServerSnapshotState.serverUrl,
            accountEncryptionFirstKey: {
                accountId: 'account-test',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{}',
                pending: 'pending',
                createdAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                migrationSubmissionAttempted: true,
            },
        })).resolves.toBe(true);
        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toMatchObject({
            serverMismatch: false,
            value: {
                accountEncryptionFirstKey: {
                    migrationSubmissionAttempted: true,
                },
            },
        });
        const { abandonAccountEncryptionFirstKeyExternalAuth } = await import(
            '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth'
        );
        const { trackLogout } = await import('@/track');
        let recovery: Parameters<typeof abandonAccountEncryptionFirstKeyExternalAuth>[0] | null = null;
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            const logoutCallsBefore =
                vi.mocked(trackLogout).mock.calls.length;
            const beforeMutation = vi.fn();
            const result = await auth.logout({
                beforeMutation,
            });

            expect(result).toMatchObject({ kind: 'finish_encryption_setup' });
            expect(beforeMutation).not.toHaveBeenCalled();
            expect(vi.mocked(trackLogout).mock.calls.length)
                .toBe(logoutCallsBefore);
            expect(syncSwitchServerSpy).not.toHaveBeenCalledWith(null);
            expect(await TokenStorage.getCredentials()).toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            if (result.kind !== 'finish_encryption_setup') {
                throw new Error('Expected first-key custody recovery');
            }
            recovery = result.recovery;
        } finally {
            if (recovery) {
                await expect(
                    abandonAccountEncryptionFirstKeyExternalAuth(recovery),
                ).resolves.toEqual({ kind: 'abandoned' });
                await expect(TokenStorage.readPendingExternalAuthState()).resolves.toEqual({
                    value: null,
                    serverMismatch: false,
                });
            }
            await screen.unmount();
        }
    });

    it('does not mutate auth state when the authorized pre-mutation callback fails', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        await TokenStorage.setCredentials({ token });
        const { trackLogout } = await import('@/track');
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            const logoutCallsBefore =
                vi.mocked(trackLogout).mock.calls.length;

            await expect(auth.logout({
                beforeMutation: () => {
                    throw new Error('navigation failed');
                },
            })).rejects.toThrow('navigation failed');

            expect(vi.mocked(trackLogout).mock.calls.length)
                .toBe(logoutCallsBefore);
            expect(syncSwitchServerSpy).not.toHaveBeenCalledWith(null);
            expect(await TokenStorage.getCredentials()).toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
        } finally {
            await screen.unmount();
        }
    });

    it('awaits an authorized asynchronous pre-mutation callback before deleting local credentials', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        await TokenStorage.setCredentials({ token });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const beforeMutation = vi.fn(async () => await pending);
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            const logout = auth.logout({ beforeMutation });
            await vi.waitFor(() => expect(beforeMutation).toHaveBeenCalledTimes(1));

            expect(await TokenStorage.getCredentials()).toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);

            await act(async () => {
                release();
                await logout;
            });
            expect(getCurrentAuth()?.isAuthenticated).toBe(false);
        } finally {
            await screen.unmount();
        }
    });

    it('logs out only the focused Home while preserving another Home and Account Service credentials', async () => {
        const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'DELETE' && String(input).includes('home-a')) {
                throw new Error('home a cleanup unavailable');
            }
            return Response.json({ success: true });
        });
        vi.stubGlobal('fetch', fetchSpy);
        serverProfilesState.profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.example.test', name: 'Home A', serverIdentityId: 'srv_logout_home_a' },
            { id: 'home-b', serverUrl: 'https://home-b.example.test', name: 'Home B', serverIdentityId: 'srv_logout_home_b' },
        ];
        activeServerSnapshotState.serverId = 'srv_logout_home_a';
        activeServerSnapshotState.serverUrl = 'https://home-a.example.test';
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.clearPendingExternalAuth()).resolves.toBe(true);
        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toEqual({
            value: null,
            serverMismatch: false,
        });
        await TokenStorage.setCredentialsForServerUrl(
            'https://home-a.example.test',
            { serverId: 'srv_logout_home_a' },
            { token: buildTokenWithSub('home-a') },
        );
        await TokenStorage.setCredentialsForServerUrl(
            'https://home-b.example.test',
            { serverId: 'srv_logout_home_b' },
            { token: buildTokenWithSub('home-b') },
        );
        const { saveExpoPushTokenGeneration } = await import('@/sync/domains/state/pushTokenRegistration');
        saveExpoPushTokenGeneration({
            current: 'ExponentPushToken[current]',
            cleanupPending: 'ExponentPushToken[last]',
        });
        const { accountDirectoryCredentialStorage } = await import('@/auth/accountDirectory/accountDirectoryCredentialStorage');
        await accountDirectoryCredentialStorage.set(
            { endpoint: 'https://accounts.example.test', serverIdentityId: 'account-service-a' },
            { token: 'account-service-token' },
        );

        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: { token: buildTokenWithSub('home-a') },
            children: React.createElement(React.Fragment, null),
        }));
        try {
            await act(async () => {
                await getCurrentAuth()?.logout();
            });
            const deletedUrls = fetchSpy.mock.calls
                .filter(([, init]) => init?.method === 'DELETE')
                .map(([url]) => String(url))
                .sort();
            expect(deletedUrls).toEqual([
                'https://home-a.example.test/v1/push-tokens/ExponentPushToken%5Bcurrent%5D',
                'https://home-a.example.test/v1/push-tokens/ExponentPushToken%5Blast%5D',
            ]);
            await expect(TokenStorage.getCredentialsForServerUrl(
                'https://home-a.example.test',
                { serverId: 'srv_logout_home_a' },
            )).resolves.toBeNull();
            await expect(TokenStorage.getCredentialsForServerUrl(
                'https://home-b.example.test',
                { serverId: 'srv_logout_home_b' },
            )).resolves.toMatchObject({ token: buildTokenWithSub('home-b') });
            await expect(accountDirectoryCredentialStorage.get(
                { endpoint: 'https://accounts.example.test', serverIdentityId: 'account-service-a' },
            )).resolves.toMatchObject({ token: 'account-service-token' });
        } finally {
            await screen.unmount();
        }
    });

    it('guards focused logout by the active Home only, while an all-credentials logout honors any Home\'s custody', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true })));
        const homeA = { id: 'srv_custody_home_a', serverUrl: 'https://home-a.example.test', name: 'Home A', serverIdentityId: 'srv_custody_home_a' };
        const homeB = { id: 'srv_custody_home_b', serverUrl: 'https://home-b.example.test', name: 'Home B', serverIdentityId: 'srv_custody_home_b' };
        serverProfilesState.profiles = [homeA, homeB];
        activeServerSnapshotState.serverId = homeB.id;
        activeServerSnapshotState.serverUrl = homeB.serverUrl;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        const homeBCredentials = { token: buildTokenWithSub('home-b') };
        await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id }, homeACredentials);
        await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, homeBCredentials);
        // Home A holds retained first-key custody; Home B is the focused Home.
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            serverId: homeA.id,
            serverUrl: homeA.serverUrl,
            accountEncryptionFirstKey: {
                accountId: 'account-home-a',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{}',
                pending: 'pending',
                createdAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                migrationSubmissionAttempted: true,
            },
        }, { serverUrl: homeA.serverUrl, serverId: homeA.id })).resolves.toBe(true);

        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: homeBCredentials,
            children: React.createElement(React.Fragment, null),
        }));
        try {
            // Signing out of every Home would destroy Home A's credential too.
            const allResult = await getCurrentAuth()?.logout({ scope: 'all-credentials' });
            expect(allResult).toMatchObject({ kind: 'finish_encryption_setup' });
            await expect(TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }))
                .resolves.toMatchObject(homeBCredentials);

            // Signing out of Home B alone is not a credential mutation of Home A.
            let focusedResult: unknown;
            await act(async () => {
                focusedResult = await getCurrentAuth()?.logout();
            });
            expect(focusedResult).toEqual({ kind: 'completed' });
            await expect(TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }))
                .resolves.toBeNull();
            await expect(TokenStorage.getCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id }))
                .resolves.toMatchObject(homeACredentials);
            await expect(TokenStorage.readPendingExternalAuthStateForServerUrl(homeA.serverUrl, { serverId: homeA.id }))
                .resolves.toMatchObject({ value: { accountEncryptionFirstKey: { migrationSubmissionAttempted: true } } });
        } finally {
            await screen.unmount();
        }
    });

    it('removes focused Home credentials and updates local auth before push cleanup settles', async () => {
        let releaseCleanup!: () => void;
        const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
        const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'DELETE') await cleanupGate;
            return Response.json({ success: true });
        });
        vi.stubGlobal('fetch', fetchSpy);
        const profile = {
            id: 'home-a',
            serverUrl: 'https://home-a.example.test',
            name: 'Home A',
            serverIdentityId: 'srv_logout_home_a',
        };
        serverProfilesState.profiles = [profile];
        activeServerSnapshotState.serverId = profile.serverIdentityId;
        activeServerSnapshotState.serverUrl = profile.serverUrl;
        const homeCredentials = { token: buildTokenWithSub('home-a') };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentialsForServerUrl(
            profile.serverUrl,
            { serverId: profile.serverIdentityId },
            homeCredentials,
        );
        const { saveExpoPushTokenGeneration } = await import('@/sync/domains/state/pushTokenRegistration');
        saveExpoPushTokenGeneration({
            current: 'ExponentPushToken[current]',
            cleanupPending: null,
        });

        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: homeCredentials,
            children: React.createElement(React.Fragment, null),
        }));
        let logoutPromise: Promise<unknown> | undefined;
        let logoutSettled = false;
        try {
            await act(async () => {
                logoutPromise = getCurrentAuth()?.logout().then((result) => {
                    logoutSettled = true;
                    return result;
                });
                if (!logoutPromise) throw new Error('Expected current auth logout');
                await vi.waitFor(() => expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true));
            });

            await expect(TokenStorage.getCredentialsForServerUrl(
                profile.serverUrl,
                { serverId: profile.serverIdentityId },
            )).resolves.toBeNull();
            await vi.waitFor(() => expect(getCurrentAuth()).toMatchObject({
                isAuthenticated: false,
                credentials: null,
            }));
            await vi.waitFor(() => expect(logoutSettled).toBe(true));
        } finally {
            releaseCleanup();
            await act(async () => {
                await logoutPromise;
            });
            await screen.unmount();
        }
    });

    it('keeps the newly focused Home authenticated when an earlier Home logout resumes', async () => {
        const fetchSpy = vi.fn(async (
            _input: RequestInfo | URL,
            _init?: RequestInit,
        ) => Response.json({ success: true }));
        vi.stubGlobal('fetch', fetchSpy);
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        const homeBCredentials = { token: buildTokenWithSub('home-b') };
        serverProfilesState.profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.example.test', name: 'Home A', serverIdentityId: 'srv_logout_home_a' },
            { id: 'home-b', serverUrl: 'https://home-b.example.test', name: 'Home B', serverIdentityId: 'srv_logout_home_b' },
        ];
        activeServerSnapshotState.serverId = 'srv_logout_home_a';
        activeServerSnapshotState.serverUrl = 'https://home-a.example.test';
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.clearPendingExternalAuth()).resolves.toBe(true);
        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toEqual({
            value: null,
            serverMismatch: false,
        });
        await TokenStorage.setCredentialsForServerUrl(
            'https://home-a.example.test',
            { serverId: 'srv_logout_home_a' },
            homeACredentials,
        );
        await TokenStorage.setCredentialsForServerUrl(
            'https://home-b.example.test',
            { serverId: 'srv_logout_home_b' },
            homeBCredentials,
        );
        const { saveExpoPushTokenGeneration } = await import('@/sync/domains/state/pushTokenRegistration');
        saveExpoPushTokenGeneration({
            current: 'ExponentPushToken[current]',
            cleanupPending: 'ExponentPushToken[last]',
        });
        const { accountDirectoryCredentialStorage } = await import('@/auth/accountDirectory/accountDirectoryCredentialStorage');
        await accountDirectoryCredentialStorage.set(
            { endpoint: 'https://accounts.example.test', serverIdentityId: 'account-service-a' },
            { token: 'account-service-token' },
        );

        let resumeLogout!: () => void;
        const logoutPaused = new Promise<void>((resolve) => { resumeLogout = resolve; });
        const beforeMutation = vi.fn(async () => await logoutPaused);
        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: homeACredentials,
            children: React.createElement(React.Fragment, null),
        }));
        try {
            const homeALogout = getCurrentAuth()?.logout({ beforeMutation });
            if (!homeALogout) throw new Error('Expected current auth logout');
            await vi.waitFor(() => expect(beforeMutation).toHaveBeenCalledTimes(1));

            activeServerSnapshotState.serverId = 'srv_logout_home_b';
            activeServerSnapshotState.serverUrl = 'https://home-b.example.test';
            activeServerSnapshotState.generation += 1;
            switchConnectionToActiveServerSpy.mockResolvedValueOnce(homeBCredentials);
            await act(async () => {
                await getCurrentAuth()?.refreshFromActiveServer();
            });
            expect(getCurrentAuth()).toMatchObject({
                isAuthenticated: true,
                credentials: homeBCredentials,
            });

            await act(async () => {
                resumeLogout();
                await homeALogout;
            });

            expect(getCurrentAuth()).toMatchObject({
                isAuthenticated: true,
                credentials: homeBCredentials,
            });
            expect(syncSwitchServerSpy).not.toHaveBeenCalledWith(null);
            await expect(TokenStorage.getCredentialsForServerUrl(
                'https://home-a.example.test',
                { serverId: 'srv_logout_home_a' },
            )).resolves.toBeNull();
            await expect(TokenStorage.getCredentialsForServerUrl(
                'https://home-b.example.test',
                { serverId: 'srv_logout_home_b' },
            )).resolves.toEqual(homeBCredentials);
            await expect(accountDirectoryCredentialStorage.get(
                { endpoint: 'https://accounts.example.test', serverIdentityId: 'account-service-a' },
            )).resolves.toMatchObject({ token: 'account-service-token' });
            const deletedUrls = fetchSpy.mock.calls
                .filter(([, init]) => init?.method === 'DELETE')
                .map(([url]) => String(url))
                .sort();
            expect(deletedUrls).toEqual([
                'https://home-a.example.test/v1/push-tokens/ExponentPushToken%5Bcurrent%5D',
                'https://home-a.example.test/v1/push-tokens/ExponentPushToken%5Blast%5D',
            ]);
        } finally {
            await screen.unmount();
        }
    });

    it('explicitly forgets all Home and Account Service credentials without removing Home profiles', async () => {
        const fetchSpy = vi.fn(async (
            _input: RequestInfo | URL,
            _init?: RequestInit,
        ) => Response.json({ success: true }));
        vi.stubGlobal('fetch', fetchSpy);
        const profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.example.test', name: 'Home A', serverIdentityId: 'srv_forget_home_a' },
            { id: 'home-b', serverUrl: 'https://home-b.example.test', name: 'Home B', serverIdentityId: 'srv_forget_home_b' },
        ];
        serverProfilesState.profiles = profiles;
        activeServerSnapshotState.serverId = 'srv_forget_home_a';
        activeServerSnapshotState.serverUrl = 'https://home-a.example.test';
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        const homeBCredentials = { token: buildTokenWithSub('home-b') };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentialsForServerUrl(
            profiles[0]!.serverUrl,
            { serverId: profiles[0]!.serverIdentityId },
            homeACredentials,
        );
        await TokenStorage.setCredentialsForServerUrl(
            profiles[1]!.serverUrl,
            { serverId: profiles[1]!.serverIdentityId },
            homeBCredentials,
        );
        const { saveExpoPushTokenGeneration } = await import('@/sync/domains/state/pushTokenRegistration');
        saveExpoPushTokenGeneration({
            current: 'ExponentPushToken[current]',
            cleanupPending: 'ExponentPushToken[last]',
        });
        const { accountDirectoryCredentialStorage } = await import('@/auth/accountDirectory/accountDirectoryCredentialStorage');
        const directoryTarget = {
            endpoint: 'https://accounts.example.test',
            serverIdentityId: 'account-service-a',
        };
        await accountDirectoryCredentialStorage.set(directoryTarget, { token: 'account-service-token' });
        await TokenStorage.setPendingAccountDirectoryAuth({
            credentialTarget: 'account_directory',
            entryIntent: { kind: 'enter', target: { kind: 'automatic' } },
            ...directoryTarget,
            canonicalServerUrl: directoryTarget.endpoint,
            provider: 'github',
            purpose: 'account_directory',
            pending: 'pending-account-service-auth',
            createdAt: Date.now() - 100,
            expiresAt: Date.now() + 10_000,
        });

        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: homeACredentials,
            children: React.createElement(React.Fragment, null),
        }));
        try {
            await act(async () => {
                await getCurrentAuth()?.logout({ scope: 'all-credentials' });
            });

            await expect(TokenStorage.getCredentialsForServerUrl(
                profiles[0]!.serverUrl,
                { serverId: profiles[0]!.serverIdentityId },
            )).resolves.toBeNull();
            await expect(TokenStorage.getCredentialsForServerUrl(
                profiles[1]!.serverUrl,
                { serverId: profiles[1]!.serverIdentityId },
            )).resolves.toBeNull();
            await expect(accountDirectoryCredentialStorage.get(directoryTarget)).resolves.toBeNull();
            await expect(TokenStorage.getPendingAccountDirectoryAuth(directoryTarget)).resolves.toBeNull();
            expect(getCurrentAuth()).toMatchObject({
                isAuthenticated: false,
                credentials: null,
            });
            expect(serverProfilesState.profiles).toBe(profiles);
            const deletedUrls = fetchSpy.mock.calls
                .filter(([, init]) => init?.method === 'DELETE')
                .map(([url]) => String(url))
                .sort();
            expect(deletedUrls).toEqual([
                'https://home-a.example.test/v1/push-tokens/ExponentPushToken%5Bcurrent%5D',
                'https://home-a.example.test/v1/push-tokens/ExponentPushToken%5Blast%5D',
                'https://home-b.example.test/v1/push-tokens/ExponentPushToken%5Bcurrent%5D',
                'https://home-b.example.test/v1/push-tokens/ExponentPushToken%5Blast%5D',
            ]);
        } finally {
            await screen.unmount();
        }
    });

    it('forgets local credentials before concurrently isolating per-Home push cleanup failures', async () => {
        let releaseCleanup!: () => void;
        const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
        const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'DELETE') {
                await cleanupGate;
                if (String(input).includes('home-a')) throw new Error('Home A is offline');
            }
            return Response.json({ success: true });
        });
        vi.stubGlobal('fetch', fetchSpy);
        const profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.example.test', name: 'Home A', serverIdentityId: 'srv_forget_home_a' },
            { id: 'home-b', serverUrl: 'https://home-b.example.test', name: 'Home B', serverIdentityId: 'srv_forget_home_b' },
        ];
        serverProfilesState.profiles = profiles;
        activeServerSnapshotState.serverId = profiles[0]!.serverIdentityId;
        activeServerSnapshotState.serverUrl = profiles[0]!.serverUrl;
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        const homeBCredentials = { token: buildTokenWithSub('home-b') };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentialsForServerUrl(
            profiles[0]!.serverUrl,
            { serverId: profiles[0]!.serverIdentityId },
            homeACredentials,
        );
        await TokenStorage.setCredentialsForServerUrl(
            profiles[1]!.serverUrl,
            { serverId: profiles[1]!.serverIdentityId },
            homeBCredentials,
        );
        const { saveExpoPushTokenGeneration } = await import('@/sync/domains/state/pushTokenRegistration');
        saveExpoPushTokenGeneration({
            current: 'ExponentPushToken[current]',
            cleanupPending: null,
        });

        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: homeACredentials,
            children: React.createElement(React.Fragment, null),
        }));
        let logoutPromise: Promise<unknown> | undefined;
        let logoutSettled = false;
        try {
            await act(async () => {
                logoutPromise = getCurrentAuth()?.logout({ scope: 'all-credentials' }).then((result) => {
                    logoutSettled = true;
                    return result;
                });
                if (!logoutPromise) throw new Error('Expected current auth logout');
                await vi.waitFor(() => expect(fetchSpy.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true));
            });

            const deleteUrls = fetchSpy.mock.calls
                .filter(([, init]) => init?.method === 'DELETE')
                .map(([url]) => String(url));
            expect(deleteUrls).toEqual(expect.arrayContaining([
                'https://home-a.example.test/v1/push-tokens/ExponentPushToken%5Bcurrent%5D',
                'https://home-b.example.test/v1/push-tokens/ExponentPushToken%5Bcurrent%5D',
            ]));
            await expect(TokenStorage.getCredentialsForServerUrl(
                profiles[0]!.serverUrl,
                { serverId: profiles[0]!.serverIdentityId },
            )).resolves.toBeNull();
            await expect(TokenStorage.getCredentialsForServerUrl(
                profiles[1]!.serverUrl,
                { serverId: profiles[1]!.serverIdentityId },
            )).resolves.toBeNull();
            await vi.waitFor(() => expect(getCurrentAuth()).toMatchObject({
                isAuthenticated: false,
                credentials: null,
            }));
            await vi.waitFor(() => expect(logoutSettled).toBe(true));
        } finally {
            releaseCleanup();
            await act(async () => {
                await logoutPromise;
            });
            await screen.unmount();
        }
    });

    it('blocks different-token replacement and unproven same-token keyed replacement', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        await TokenStorage.setCredentials({ token });
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            serverId: activeServerSnapshotState.serverId,
            serverUrl: activeServerSnapshotState.serverUrl,
            accountEncryptionFirstKey: {
                accountId: 'account-test',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{}',
                pending: 'pending',
                createdAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                migrationSubmissionAttempted: true,
            },
        })).resolves.toBe(true);
        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toMatchObject({
            serverMismatch: false,
            value: {
                accountEncryptionFirstKey: {
                    migrationSubmissionAttempted: true,
                },
            },
        });
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            await expect(auth.loginWithCredentials({ token: 'different-token' }))
                .resolves.toMatchObject({ kind: 'finish_encryption_setup' });
            expect(await TokenStorage.getCredentials()).toEqual({ token });

            await expect(auth.loginWithCredentials({ token, secret: 'recovered-secret' }))
                .resolves.toMatchObject({ kind: 'finish_encryption_setup' });
            expect(await TokenStorage.getCredentials()).toEqual({ token });
        } finally {
            await screen.unmount();
        }
    });

    it('scopes the first-key custody guard to the Homes a logout actually mutates', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true })));
        const profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.example.test', name: 'Home A', serverIdentityId: 'srv_custody_home_a' },
            { id: 'home-b', serverUrl: 'https://home-b.example.test', name: 'Home B', serverIdentityId: 'srv_custody_home_b' },
        ];
        serverProfilesState.profiles = profiles;
        activeServerSnapshotState.serverId = profiles[1]!.serverIdentityId;
        activeServerSnapshotState.serverUrl = profiles[1]!.serverUrl;
        const homeACredentials = { token: buildTokenWithSub('home-a') };
        const homeBCredentials = { token: buildTokenWithSub('home-b') };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentialsForServerUrl(profiles[0]!.serverUrl, { serverId: profiles[0]!.serverIdentityId }, homeACredentials);
        await TokenStorage.setCredentialsForServerUrl(profiles[1]!.serverUrl, { serverId: profiles[1]!.serverIdentityId }, homeBCredentials);
        // First-key setup was attempted, and is retained, on Home A only.
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            serverId: profiles[0]!.serverIdentityId,
            serverUrl: profiles[0]!.serverUrl,
            accountEncryptionFirstKey: {
                accountId: 'account-home-a',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{}',
                pending: 'pending',
                createdAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                migrationSubmissionAttempted: true,
            },
        }, { serverUrl: profiles[0]!.serverUrl, serverId: profiles[0]!.serverIdentityId })).resolves.toBe(true);

        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: homeBCredentials,
            children: React.createElement(React.Fragment, null),
        }));
        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            // Logging out of focused Home B deletes nothing on Home A.
            await expect(auth.logout()).resolves.toMatchObject({ kind: 'completed' });
            await expect(TokenStorage.getCredentialsForServerUrl(profiles[1]!.serverUrl, { serverId: profiles[1]!.serverIdentityId }))
                .resolves.toBeNull();
            await expect(TokenStorage.getCredentialsForServerUrl(profiles[0]!.serverUrl, { serverId: profiles[0]!.serverIdentityId }))
                .resolves.toEqual(homeACredentials);
            await expect(TokenStorage.readPendingExternalAuthStateForServerUrl(profiles[0]!.serverUrl, { serverId: profiles[0]!.serverIdentityId }))
                .resolves.toMatchObject({ value: { accountEncryptionFirstKey: { migrationSubmissionAttempted: true } } });

            // Forgetting every credential would delete Home A's: it stays guarded.
            await expect(getCurrentAuth()!.logout({ scope: 'all-credentials' }))
                .resolves.toMatchObject({ kind: 'finish_encryption_setup' });
            await expect(TokenStorage.getCredentialsForServerUrl(profiles[0]!.serverUrl, { serverId: profiles[0]!.serverIdentityId }))
                .resolves.toEqual(homeACredentials);
        } finally {
            await screen.unmount();
        }
    });
});
