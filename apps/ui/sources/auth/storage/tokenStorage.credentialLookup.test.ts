import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from './tokenStorage.testHelpers';

/**
 * Cold boot blocks on the credential read, and on native every scope probe is a keychain round trip.
 * These tests pin the two things that matter there: the legacy scopes are probed together rather
 * than one round trip at a time, and the primary scope alone still answers the common case.
 */
const secureStoreState = vi.hoisted(() => {
    const values = new Map<string, string>();
    const readOrder: string[] = [];
    const state = {
        values,
        readOrder,
        inFlightReads: 0,
        maxConcurrentReads: 0,
        readLatencyMs: 5,
        getItemAsync: vi.fn(async (key: string) => {
            readOrder.push(key);
            state.inFlightReads += 1;
            state.maxConcurrentReads = Math.max(state.maxConcurrentReads, state.inFlightReads);
            try {
                await new Promise((resolve) => setTimeout(resolve, state.readLatencyMs));
                return values.get(key) ?? null;
            } finally {
                state.inFlightReads -= 1;
            }
        }),
        setItemAsync: vi.fn(async (key: string, value: string) => {
            values.set(key, value);
        }),
        deleteItemAsync: vi.fn(async (key: string) => {
            values.delete(key);
        }),
    };
    return state;
});

installTokenStorageWebPlatformMocks({
    reactNative: async () => {
        const stub = await import('../../dev/reactNativeStub');
        return {
            ...stub,
            Platform: {
                ...(stub.Platform ?? {}),
                OS: 'ios',
                select: (options: Record<string, unknown>) =>
                    options.ios ?? options.native ?? options.default ?? options.web ?? options.android,
            },
        };
    },
    secureStore: async () => secureStoreState,
});

const SERVER_URL = 'https://api.example.test';

function installServerProfilesMockWithLegacyScopes(): void {
    vi.doMock('@/sync/domains/server/serverProfiles', () => ({
        getActiveServerId: () => 'srv-identity',
        getActiveServerUrl: () => SERVER_URL,
        listServerProfiles: () => [
            {
                id: 'srv-legacy-a',
                serverIdentityId: 'srv-identity',
                serverUrl: SERVER_URL,
                legacyServerIds: ['srv-legacy-b'],
            },
        ],
        areServerProfileIdentifiersEquivalent: () => true,
    }));
}

/**
 * Two Homes can reach the same routing URL at once: one currently canonical there,
 * and one that moved its canonical URL while retaining the old alias. The anonymous
 * URL-hash credential stored under that URL belongs to neither identity in particular.
 */
function installServerProfilesMockWithSharedUrl(): void {
    vi.doMock('@/sync/domains/server/serverProfiles', () => ({
        getActiveServerId: () => 'srv-identity',
        getActiveServerUrl: () => SERVER_URL,
        listServerProfiles: () => [
            {
                id: 'srv-legacy-a',
                serverIdentityId: 'srv-identity',
                serverUrl: SERVER_URL,
                canonicalServerUrl: SERVER_URL,
                legacyServerIds: ['srv-legacy-b'],
            },
            {
                id: 'srv-moved',
                serverIdentityId: 'srv-moved-identity',
                serverUrl: SERVER_URL,
                canonicalServerUrl: 'https://moved.example.test',
            },
        ],
        areServerProfileIdentifiersEquivalent: (left: string, right: string) => left === right,
    }));
}

function installServerProfilesMockWithoutProfiles(): void {
    vi.doMock('@/sync/domains/server/serverProfiles', () => ({
        getActiveServerId: () => null,
        getActiveServerUrl: () => SERVER_URL,
        listServerProfiles: () => [],
        areServerProfileIdentifiersEquivalent: () => false,
    }));
}

describe('TokenStorage credential lookup (native keychain)', () => {
    beforeEach(() => {
        vi.resetModules();
        secureStoreState.values.clear();
        secureStoreState.readOrder.length = 0;
        secureStoreState.inFlightReads = 0;
        secureStoreState.maxConcurrentReads = 0;
        secureStoreState.readLatencyMs = 5;
        secureStoreState.getItemAsync.mockClear();
        secureStoreState.setItemAsync.mockClear();
        secureStoreState.deleteItemAsync.mockClear();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('probes every legacy scope concurrently instead of one keychain round trip at a time', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');

        // Nothing is stored anywhere: the lookup has to probe the primary scope and then every
        // legacy scope, which is the worst case that used to serialise on the boot gate.
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();

        const legacyReadCount = secureStoreState.getItemAsync.mock.calls.length - 1;
        expect(legacyReadCount).toBeGreaterThan(1);
        expect(secureStoreState.maxConcurrentReads).toBe(legacyReadCount);
    });

    it('does not probe legacy scopes at all when the primary scope answers', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');

        await expect(TokenStorage.setCredentials({ token: 'token-1', secret: 'secret-1' })).resolves.toBe(true);
        const primaryKey = [...secureStoreState.values.keys()].find((key) => key.includes('auth_credentials'));
        expect(primaryKey).toBeDefined();

        vi.resetModules();
        secureStoreState.readOrder.length = 0;
        secureStoreState.getItemAsync.mockClear();
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage: FreshTokenStorage } = await import('./tokenStorage');

        await expect(FreshTokenStorage.getCredentials()).resolves.toEqual({ token: 'token-1', secret: 'secret-1' });
        expect(secureStoreState.readOrder).toEqual([primaryKey]);
    });

    it('shares concurrent identical cold scoped reads at the Home authority', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');
        await TokenStorage.setCredentials({ token: 'before' });
        vi.resetModules();
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage: Fresh } = await import('./tokenStorage');
        secureStoreState.readOrder.length = 0;
        // Web Locks are the cross-tab Home mutation authority. Its queue is
        // also used when this native-host fixture has a browser coordinator.
        let tail: Promise<unknown> = Promise.resolve();
        const request = vi.fn((_name: string, run: () => Promise<unknown>) => {
            const result = tail.then(run);
            tail = result.catch(() => undefined);
            return result;
        });
        vi.stubGlobal('navigator', { locks: { request } });
        const reads = Array.from({ length: 12 }, () => Fresh.getCredentialsForServerUrl(SERVER_URL, {
            serverId: 'srv-identity', storageReadFailure: 'surface',
        }));
        expect(await Promise.all(reads)).toEqual(Array(12).fill({ token: 'before' }));
        expect(secureStoreState.readOrder).toHaveLength(1);
        expect(request).toHaveBeenCalledTimes(1);
        // Settlement releases the share; the native owner's existing raw cache
        // is independent of this one-operation queue sharing.
        expect(await Fresh.getCredentialsForServerUrl(SERVER_URL, {
            serverId: 'srv-identity', storageReadFailure: 'surface',
        })).toEqual({ token: 'before' });
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('does not let a post-mutation read join an older scoped read still in flight', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');
        await TokenStorage.setCredentials({ token: 'before' });
        vi.resetModules();
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage: Fresh } = await import('./tokenStorage');
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let started = false;
        secureStoreState.getItemAsync.mockImplementationOnce(async (key: string) => {
            const captured = secureStoreState.values.get(key) ?? null;
            started = true;
            await gate;
            return captured;
        });
        const options = { serverId: 'srv-identity', storageReadFailure: 'surface' as const };
        const before = Fresh.getCredentialsForServerUrl(SERVER_URL, options);
        await vi.waitFor(() => expect(started).toBe(true));
        const mutation = Fresh.setCredentialsForServerUrl(SERVER_URL, options, { token: 'after' });
        const after = Fresh.getCredentialsForServerUrl(SERVER_URL, options);
        release();
        expect(await before).toEqual({ token: 'before' });
        expect(await mutation).toBe(true);
        expect(await after).toEqual({ token: 'after' });
    });

    it('interrupts sharing when a profile-adoption writer already holds its Home authority', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');
        await TokenStorage.setCredentials({ token: 'before' });
        vi.resetModules();
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage: Fresh, setHomeCredentialsWithRollbackUnderMutationAuthority } = await import('./tokenStorage');
        const { withHomeMutationAuthority } = await import('@/sync/domains/server/homeMutationLock');
        // Native adoption has a composed authority but no browser Web Lock.
        // Node's optional Web Locks must not turn this case into a lock deadlock.
        vi.stubGlobal('navigator', {});
        await withHomeMutationAuthority(undefined, async (authority) => {
            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            let started = false;
            secureStoreState.getItemAsync.mockImplementationOnce(async (key: string) => {
                const captured = secureStoreState.values.get(key) ?? null;
                started = true;
                await gate;
                return captured;
            });
            const options = { serverId: 'srv-identity', storageReadFailure: 'surface' as const };
            const before = Fresh.getCredentialsForServerUrl(SERVER_URL, options);
            await vi.waitFor(() => expect(started).toBe(true));
            const mutation = setHomeCredentialsWithRollbackUnderMutationAuthority(authority, SERVER_URL, options, { token: 'after' });
            const after = Fresh.getCredentialsForServerUrl(SERVER_URL, options);
            release();
            expect(await before).toEqual({ token: 'before' });
            expect(await mutation).not.toBeNull();
            expect(await after).toEqual({ token: 'after' });
        });
    });

    it('keeps legacy scope precedence and still migrates the winner onto the primary scope', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');

        // Discover the scope layout by asking for a lookup with nothing stored.
        await TokenStorage.getCredentials();
        const [primaryKey, ...legacyKeys] = [...secureStoreState.readOrder];
        expect(primaryKey).toBeDefined();
        expect(legacyKeys.length).toBeGreaterThan(1);

        secureStoreState.values.set(legacyKeys[0]!, JSON.stringify({ token: 'legacy-first', secret: 's1' }));
        secureStoreState.values.set(legacyKeys[1]!, JSON.stringify({ token: 'legacy-second', secret: 's2' }));

        vi.resetModules();
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage: FreshTokenStorage } = await import('./tokenStorage');

        await expect(FreshTokenStorage.getCredentials()).resolves.toEqual({ token: 'legacy-first', secret: 's1' });
        expect(secureStoreState.values.get(primaryKey!)).toBe(JSON.stringify({ token: 'legacy-first', secret: 's1' }));
        expect(secureStoreState.values.has(legacyKeys[0]!)).toBe(false);
        // Losing legacy scopes are left alone; only the migrated one is retired.
        expect(secureStoreState.values.has(legacyKeys[1]!)).toBe(true);
    });

    it('does not overwrite or misattribute a primary credential written during legacy migration', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');
        await TokenStorage.getCredentials();
        const [primaryKey, legacyKey] = [...secureStoreState.readOrder];
        expect(primaryKey).toBeDefined();
        expect(legacyKey).toBeDefined();
        const legacyRaw = JSON.stringify({ token: 'legacy-token', secret: 'legacy-secret' });
        const concurrentRaw = JSON.stringify({ token: 'concurrent-token', secret: 'concurrent-secret' });
        secureStoreState.values.set(legacyKey!, legacyRaw);

        vi.resetModules();
        installServerProfilesMockWithLegacyScopes();
        let primaryReads = 0;
        secureStoreState.getItemAsync.mockImplementation(async (key: string) => {
            if (key === primaryKey && ++primaryReads === 2) {
                secureStoreState.values.set(primaryKey!, concurrentRaw);
            }
            return secureStoreState.values.get(key) ?? null;
        });
        const { TokenStorage: FreshTokenStorage } = await import('./tokenStorage');

        await expect(FreshTokenStorage.getCredentials()).resolves.toEqual({
            token: 'concurrent-token',
            secret: 'concurrent-secret',
        });
        expect(secureStoreState.values.get(primaryKey!)).toBe(concurrentRaw);
        expect(secureStoreState.values.get(legacyKey!)).toBe(legacyRaw);
        expect(secureStoreState.setItemAsync).not.toHaveBeenCalledWith(primaryKey, legacyRaw);
    });

    it('never promotes an anonymous URL-hash credential into an identity that shares that URL with another Home', async () => {
        installServerProfilesMockWithoutProfiles();
        const { TokenStorage } = await import('./tokenStorage');

        await expect(TokenStorage.setCredentialsForServerUrl(
            SERVER_URL,
            {},
            { token: 'anonymous-url', secret: 'anon' },
        )).resolves.toBe(true);
        const [urlHashKey] = [...secureStoreState.values.keys()];
        expect(urlHashKey).toBeDefined();

        vi.resetModules();
        secureStoreState.readOrder.length = 0;
        installServerProfilesMockWithSharedUrl();
        const { TokenStorage: SharedUrlTokenStorage } = await import('./tokenStorage');

        // Ownership of the anonymous scope is ambiguous, so it is neither read as
        // this identity's credential nor migrated into (and deleted from) it.
        await expect(
            SharedUrlTokenStorage.getCredentialsForServerUrl(SERVER_URL, { serverId: 'srv-identity' }),
        ).resolves.toBeNull();
        expect(secureStoreState.readOrder).not.toContain(urlHashKey);
        expect(secureStoreState.values.get(urlHashKey)).toBe(
            JSON.stringify({ token: 'anonymous-url', secret: 'anon' }),
        );
        expect([...secureStoreState.values.keys()]).toEqual([urlHashKey]);
    });

    it('applies the same lookup to an explicitly requested server URL', async () => {
        installServerProfilesMockWithLegacyScopes();
        const { TokenStorage } = await import('./tokenStorage');

        await expect(
            TokenStorage.getCredentialsForServerUrl(SERVER_URL, { serverId: 'srv-identity' }),
        ).resolves.toBeNull();

        const legacyReadCount = secureStoreState.getItemAsync.mock.calls.length - 1;
        expect(legacyReadCount).toBeGreaterThan(1);
        expect(secureStoreState.maxConcurrentReads).toBe(legacyReadCount);
    });
});
