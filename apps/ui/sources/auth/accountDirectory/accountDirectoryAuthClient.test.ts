import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';

const pendingSet = vi.hoisted(() => vi.fn(async (_value: unknown) => true));
const pendingClear = vi.hoisted(() => vi.fn(async () => true));
const directoryCredentialsSet = vi.hoisted(() => vi.fn(async () => true));
const getCredentialsMock = vi.hoisted(() => vi.fn(async () => null));
const activeServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({
    serverId: 'focused-home',
    serverUrl: 'https://focused.example.test',
    generation: 1,
})));
const authGetTokenAtEndpointMock = vi.hoisted(() => vi.fn(async () => ({ token: 'restricted-directory-token' })));
const probeServerFeaturesAtUrlMock = vi.hoisted(() => vi.fn());
const fetchHomeAuthEntryMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth/entry/authEntryClient', () => ({ fetchHomeAuthEntry: fetchHomeAuthEntryMock }));

vi.mock('@/auth/flows/getToken', () => ({
    authGetTokenAtEndpoint: authGetTokenAtEndpointMock,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    probeServerFeaturesAtUrl: probeServerFeaturesAtUrlMock,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: activeServerSnapshotMock,
}));

vi.mock('@/auth/storage/tokenStorage', async () => {
    const actual = await vi.importActual<typeof import('@/auth/storage/tokenStorage')>('@/auth/storage/tokenStorage');
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentials: getCredentialsMock,
            accountDirectoryAuthCredentials: {
                ...actual.TokenStorage.accountDirectoryAuthCredentials,
                set: directoryCredentialsSet,
            },
            setPendingAccountDirectoryAuth: pendingSet,
            clearPendingAccountDirectoryAuth: pendingClear,
        },
    };
});

import { accountDirectoryAuthClient as loadedAccountDirectoryAuthClient } from './accountDirectoryAuthClient';

function supportedFeatures(serverIdentityId = 'directory-1') {
    const features = buildServerFeaturesResponse();
    return {
        status: 'ready' as const,
        serverIdentityId,
        features: {
            ...features,
            capabilities: {
                ...features.capabilities,
                accountDirectory: {
                    version: 1 as const,
                    homeDirectory: true,
                    homeEnrollment: true,
                    homeLoginAssertion: {
                        keyId: 'a'.repeat(64),
                        publicKeyBase64Url: 'A'.repeat(43),
                    },
                },
                server: { canonicalServerUrl: 'https://canonical-directory.example.test' },
                serverIdentity: { serverIdentityId },
                auth: {
                    ...features.capabilities.auth,
                    methods: [
                        { id: 'key_challenge', actions: [
                            { id: 'provision' as const, enabled: true, mode: 'keyed' as const },
                            { id: 'login' as const, enabled: true, mode: 'keyed' as const },
                        ] },
                        { id: 'github', actions: [{ id: 'provision' as const, enabled: true, mode: 'keyed' as const }] },
                        { id: 'email_password', actions: [{ id: 'login' as const, enabled: true, mode: 'keyless' as const }] },
                    ],
                    keyChallenge: { v2: true },
                    signup: { methods: [] },
                    login: { methods: [], requiredProviders: [] },
                    recovery: { providerReset: { providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null } },
                    providers: {},
                    misconfig: [],
                },
                oauth: { providers: { github: { configured: true, enabled: true } } },
            },
        },
    };
}

describe('accountDirectoryAuthClient', () => {
    it('does not expose a competing directory reconciliation operation', () => {
        expect(loadedAccountDirectoryAuthClient).not.toHaveProperty('reconcileHomes');
    });

    it('constructs authority only from supported identity-checked discovery fields', async () => {
        const { createVerifiedAccountServiceAuthority } = await import('./accountDirectoryAuthClient');
        const snapshot = supportedFeatures('directory-authority');
        const discovery = await loadedAccountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        });
        expect(discovery.kind).toBe('supported_account_service');
        if (discovery.kind !== 'supported_account_service') return;

        expect(createVerifiedAccountServiceAuthority(discovery)).toEqual({
            endpointUrl: 'https://accounts.example.test',
            serverIdentityId: 'directory-1',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            capability: snapshot.features.capabilities.accountDirectory,
            snapshot: discovery.snapshot,
        });
    });

    beforeEach(() => {
        pendingSet.mockClear();
        pendingClear.mockClear();
        directoryCredentialsSet.mockClear();
        directoryCredentialsSet.mockResolvedValue(true);
        getCredentialsMock.mockClear();
        activeServerSnapshotMock.mockClear();
        activeServerSnapshotMock.mockReturnValue({
            serverId: 'focused-home',
            serverUrl: 'https://focused.example.test',
            generation: 1,
        });
        authGetTokenAtEndpointMock.mockClear();
        probeServerFeaturesAtUrlMock.mockReset();
        probeServerFeaturesAtUrlMock.mockResolvedValue(supportedFeatures());
        fetchHomeAuthEntryMock.mockReset();
        fetchHomeAuthEntryMock.mockResolvedValue({ kind: 'unsupported' });
        authGetTokenAtEndpointMock.mockResolvedValue({ token: 'restricted-directory-token' });
        vi.unstubAllGlobals();
    });

    it('discovers explicit endpoint methods with another Home focused without active credential or focus dependence', async () => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const activeSnapshot = vi.mocked(getActiveServerSnapshot);
        activeSnapshot.mockReturnValue({
            serverId: 'focused-home-a',
            serverUrl: 'https://home-a.example.test',
            generation: 8,
        });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const getActiveCredentials = vi.mocked(TokenStorage.getCredentials);
        probeServerFeaturesAtUrlMock.mockResolvedValueOnce(supportedFeatures('directory-b'));
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts-b.example.test/',
            requestedMethod: { kind: 'oauth', providerId: 'github' },
        })).resolves.toMatchObject({
            kind: 'supported_account_service',
            endpointUrl: 'https://accounts-b.example.test',
            serverIdentityId: 'directory-b',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            keyLoginAvailable: true,
            oauthProviderIds: ['github'],
            preferredProvisionProviderId: 'github',
            authenticationActions: [
                {
                    execution: { kind: 'generated_key' },
                    method: { id: 'key_challenge' },
                    action: { id: 'provision', mode: 'keyed' },
                },
                {
                    execution: { kind: 'key_entry' },
                    method: { id: 'key_challenge' },
                    action: { id: 'login', mode: 'keyed' },
                },
                {
                    execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' },
                    method: { id: 'github' },
                    action: { id: 'provision', mode: 'keyed' },
                },
                {
                    // The service's email sign-in is an account-service way in too.
                    execution: { kind: 'email_password', action: 'login', mode: 'keyless' },
                    method: { id: 'email_password' },
                    action: { id: 'login', mode: 'keyless' },
                },
            ],
        });

        expect(probeServerFeaturesAtUrlMock).toHaveBeenCalledWith({
            endpointUrl: 'https://accounts-b.example.test',
            force: true,
        });
        expect(activeSnapshot).not.toHaveBeenCalled();
        expect(getActiveCredentials).not.toHaveBeenCalled();
        expect(directoryCredentialsSet).not.toHaveBeenCalled();
        expect(pendingSet).not.toHaveBeenCalled();
    });

    it('uses the Account Service auth-entry projection for dynamic methods', async () => {
        fetchHomeAuthEntryMock.mockResolvedValueOnce({
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                actions: [{
                    kind: 'authenticate',
                    methodId: 'acme',
                    action: 'provision',
                    mode: 'keyed',
                    origin: 'home',
                    presentation: { displayName: 'Acme Workforce' },
                }],
                autoRedirect: null,
            },
        });

        await expect(loadedAccountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        })).resolves.toMatchObject({
            kind: 'supported_account_service',
            oauthProviderIds: ['acme'],
            preferredProvisionProviderId: 'acme',
            authenticationActions: [expect.objectContaining({
                method: expect.objectContaining({ presentation: { displayName: 'Acme Workforce' } }),
                execution: { kind: 'oauth', providerId: 'acme', mode: 'keyed' },
            })],
        });
        expect(fetchHomeAuthEntryMock).toHaveBeenCalledWith(expect.objectContaining({
            purpose: 'account_service',
            endpointUrl: 'https://accounts.example.test',
            serverId: 'directory-1',
        }));
    });

    it('offers email and password sign-in and creation on an account service, never attaching it to an existing Account', async () => {
        fetchHomeAuthEntryMock.mockResolvedValueOnce({
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                actions: [
                    { kind: 'authenticate', methodId: 'email_password', action: 'login', mode: 'either', origin: 'home',
                        passwordReset: 'email', presentation: { displayName: 'Email and password' } },
                    { kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'keyed', origin: 'home',
                        recommendedProvisionMode: 'e2ee', presentation: { displayName: 'Email and password' } },
                    { kind: 'authenticate', methodId: 'email_password', action: 'connect', mode: 'either', origin: 'home',
                        presentation: { displayName: 'Email and password' } },
                ],
                autoRedirect: null,
            },
        });

        const discovered = await loadedAccountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        });
        expect(discovered).toMatchObject({ kind: 'supported_account_service' });
        if (discovered.kind !== 'supported_account_service') throw new Error('expected a supported service');
        expect(discovered.authenticationActions.map(({ execution }) => execution)).toEqual([
            { kind: 'email_password', action: 'login', mode: 'either', passwordReset: 'email' },
            { kind: 'email_password', action: 'provision', mode: 'keyed', recommendedProvisionMode: 'e2ee' },
        ]);
    });

    it('discovers explicit endpoint methods before any Home profile exists', async () => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const activeSnapshot = vi.mocked(getActiveServerSnapshot);
        activeSnapshot.mockImplementation(() => { throw new Error('active Home must not be required'); });
        probeServerFeaturesAtUrlMock.mockResolvedValueOnce(supportedFeatures('directory-b'));
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        const result = await accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts-b.example.test',
            requestedMethod: { kind: 'key' },
        });

        expect(result.kind).toBe('supported_account_service');
        expect(probeServerFeaturesAtUrlMock).toHaveBeenCalledWith({
            endpointUrl: 'https://accounts-b.example.test',
            force: true,
        });
        expect(activeSnapshot).not.toHaveBeenCalled();
    });

    it('threads exact transport and cancellation into discovery without storing them in authority', async () => {
        const controller = new AbortController();
        const homeCarrier = {
            endpointId: 'iroh-directory',
            readObservedPath: () => 'relay' as const,
            request: async () => new Response(),
            createWebSocket: () => ({}),
        };
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        const result = await accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts-b.example.test',
            runtimeOrigin: 'http://127.0.0.1:43123',
            homeCarrier,
            signal: controller.signal,
        });

        expect(result.kind).toBe('supported_account_service');
        expect(probeServerFeaturesAtUrlMock).toHaveBeenCalledWith({
            endpointUrl: 'https://accounts-b.example.test',
            runtimeOrigin: 'http://127.0.0.1:43123',
            homeCarrier,
            signal: controller.signal,
            force: true,
        });
        expect(result).not.toHaveProperty('runtimeOrigin');
        expect(result).not.toHaveProperty('homeCarrier');
    });

    it.each([
        '',
        'not a URL',
        'ftp://accounts.example.test',
        'https://user:pass@accounts.example.test',
        'https://accounts.example.test?tenant=other',
    ])('fails a malformed explicit endpoint closed before probing: %j', async (endpointUrl) => {
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl,
        })).resolves.toMatchObject({
            kind: 'endpoint_unavailable',
            endpointUrl: '',
            reason: 'invalid_endpoint',
        });
        expect(probeServerFeaturesAtUrlMock).not.toHaveBeenCalled();
    });

    it.each([
        ['endpoint_unavailable', { status: 'error', reason: 'network' }],
        ['endpoint_unavailable', { status: 'unsupported', reason: 'endpoint_missing' }],
    ])('returns %s for an unreachable or unsupported endpoint', async (kind, snapshot) => {
        probeServerFeaturesAtUrlMock.mockResolvedValueOnce(snapshot);
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        })).resolves.toMatchObject({ kind, endpointUrl: 'https://accounts.example.test' });
    });

    it('returns identity_mismatch before exposing methods when a pinned endpoint observes a different identity', async () => {
        probeServerFeaturesAtUrlMock.mockResolvedValueOnce(supportedFeatures('directory-other'));
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
            expectedServerIdentityId: 'directory-1',
        })).resolves.toMatchObject({
            kind: 'identity_mismatch',
            endpointUrl: 'https://accounts.example.test',
            expectedServerIdentityId: 'directory-1',
            observedServerIdentityId: 'directory-other',
        });
        expect(probeServerFeaturesAtUrlMock).toHaveBeenCalledWith({
            endpointUrl: 'https://accounts.example.test',
            serverId: 'directory-1',
            force: true,
        });
        expect(directoryCredentialsSet).not.toHaveBeenCalled();
        expect(pendingSet).not.toHaveBeenCalled();
    });

    it('returns not_account_service when endpoint capabilities lack Account Directory support', async () => {
        probeServerFeaturesAtUrlMock.mockResolvedValueOnce({
            ...supportedFeatures(),
            features: {
                ...supportedFeatures().features,
                capabilities: {
                    ...supportedFeatures().features.capabilities,
                    accountDirectory: undefined,
                },
            },
        });
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://home-only.example.test',
        })).resolves.toMatchObject({
            kind: 'not_account_service',
            endpointUrl: 'https://home-only.example.test',
            serverIdentityId: 'directory-1',
        });
    });

    it('offers direct Home connection for a verified Home entered as an Account Service', async () => {
        const features = supportedFeatures('home-only');
        probeServerFeaturesAtUrlMock.mockResolvedValueOnce({
            ...features,
            features: {
                ...features.features,
                capabilities: { ...features.features.capabilities, accountDirectory: undefined },
            },
        });
        const { checkAccountServiceEndpoint } = await import('@/sync/ops/accountDirectory/selectAccountServiceEndpoint');

        await expect(checkAccountServiceEndpoint('https://home-only.example.test', {
            signal: new AbortController().signal,
        })).resolves.toEqual({
            kind: 'home_endpoint',
            homeServerIdentityId: 'home-only',
            homeUrl: 'https://canonical-directory.example.test',
        });
    });

    it('requires an advertised canonical URL for a supported Account Service', async () => {
        const features = supportedFeatures();
        probeServerFeaturesAtUrlMock.mockResolvedValueOnce({
            ...features,
            features: {
                ...features.features,
                capabilities: {
                    ...features.features.capabilities,
                    server: { canonicalServerUrl: null },
                },
            },
        });
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        })).resolves.toMatchObject({
            kind: 'not_account_service',
            endpointUrl: 'https://accounts.example.test',
        });
    });

    it('projects only structured methods backed by an Account Directory execution provider', async () => {
        const features = supportedFeatures();
        probeServerFeaturesAtUrlMock.mockResolvedValueOnce({
            ...features,
            features: {
                ...features.features,
                capabilities: {
                    ...features.features.capabilities,
                    auth: {
                        ...features.features.capabilities.auth,
                        methods: [
                            { id: 'github', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] },
                            { id: 'gitlab', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] },
                            { id: 'google', actions: [{ id: 'login', enabled: true, mode: 'keyless' }] },
                            { id: 'oidc', actions: [{ id: 'provision', enabled: true, mode: 'either' }] },
                        ],
                    },
                    oauth: {
                        providers: {
                            github: { configured: true, enabled: true },
                            gitlab: { configured: false, enabled: true },
                            google: { configured: true, enabled: true },
                            oidc: { configured: true, enabled: false },
                        },
                    },
                },
            },
        });
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        })).resolves.toMatchObject({
            kind: 'supported_account_service',
            oauthProviderIds: ['github', 'gitlab', 'google', 'oidc'],
            preferredProvisionProviderId: 'github',
        });
    });

    it('uses the provenance-bounded legacy adapter when structured methods are absent', async () => {
        const features = supportedFeatures();
        probeServerFeaturesAtUrlMock.mockResolvedValueOnce({
            ...features,
            features: {
                ...features.features,
                capabilities: {
                    ...features.features.capabilities,
                    auth: {
                        keyChallenge: { v2: false },
                        signup: { methods: [{ id: 'github', enabled: true }] },
                        login: { methods: [], requiredProviders: [] },
                        recovery: { providerReset: { providers: [] } },
                        ui: { autoRedirect: { enabled: false, providerId: null } },
                        providers: {},
                        misconfig: [],
                    },
                    oauth: { providers: { github: { configured: true, enabled: true } } },
                },
            },
        });
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
            requestedMethod: { kind: 'oauth', providerId: 'github' },
        })).resolves.toMatchObject({
            kind: 'supported_account_service',
            endpointUrl: 'https://accounts.example.test',
            keyLoginAvailable: false,
            oauthProviderIds: ['github'],
            preferredProvisionProviderId: 'github',
        });
        expect(directoryCredentialsSet).not.toHaveBeenCalled();
        expect(pendingSet).not.toHaveBeenCalled();
    });

    it('does not resurrect legacy methods from an explicitly empty structured catalog', async () => {
        const features = supportedFeatures();
        probeServerFeaturesAtUrlMock.mockResolvedValueOnce({
            ...features,
            features: {
                ...features.features,
                capabilities: {
                    ...features.features.capabilities,
                    auth: {
                        ...features.features.capabilities.auth,
                        methods: [],
                        keyChallenge: { v2: false },
                        signup: { methods: [{ id: 'github', enabled: true }] },
                    },
                    oauth: { providers: { github: { configured: true, enabled: true } } },
                },
            },
        });
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
            requestedMethod: { kind: 'oauth', providerId: 'github' },
        })).resolves.toMatchObject({
            kind: 'requested_method_unavailable',
            authenticationCatalog: { provenance: 'structured', methods: [] },
            authenticationActions: [],
            oauthProviderIds: [],
        });
    });

    it('logs in by key through the restricted endpoint routes and stores only Directory credentials', async () => {
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');
        const secret = new Uint8Array(32).fill(11);
        const verifiedServerFeaturesSnapshot = supportedFeatures('directory-1');

        await expect(accountDirectoryAuthClient.loginWithKey({
            endpointUrl: 'https://accounts.example.test/',
            endpointServerIdentityId: 'directory-1',
            canonicalServerUrl: 'https://canonical-directory.example.test/',
            secret,
            verifiedServerFeaturesSnapshot,
        })).resolves.toEqual({ token: 'restricted-directory-token' });

        expect(authGetTokenAtEndpointMock).toHaveBeenCalledWith({
            endpointUrl: 'https://accounts.example.test',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            serverId: 'directory-1',
            serverIdentityId: 'directory-1',
            secret,
            requireKeyChallengeV2: true,
            credentialTarget: 'account_directory',
            verifiedServerFeaturesSnapshot,
        });
        expect(directoryCredentialsSet).toHaveBeenCalledWith(
            {
                endpoint: 'https://accounts.example.test',
                serverIdentityId: 'directory-1',
            },
            { token: 'restricted-directory-token' },
        );
        expect(pendingSet).not.toHaveBeenCalled();
    });

    it('fails key login when restricted credential persistence fails', async () => {
        directoryCredentialsSet.mockResolvedValueOnce(false);
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.loginWithKey({
            endpointUrl: 'https://accounts.example.test',
            endpointServerIdentityId: 'directory-1',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            secret: new Uint8Array(32).fill(12),
            verifiedServerFeaturesSnapshot: supportedFeatures('directory-1'),
        })).rejects.toThrow('persist Account Service credentials');
    });

    it('starts OAuth against the explicit known-identity endpoint and persists only Directory pending state', async () => {
        const now = Date.now();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            expect(url).toContain('https://accounts.example.test/v1/auth/external/github/params?');
            expect(url).toContain('mode=keyless');
            expect(url).toContain('proofHash=');
            expect(url).toContain('purpose=account_directory');
            expect(url).toContain('canonicalServerUrl=https%3A%2F%2Fcanonical-directory.example.test');
            return new Response(JSON.stringify({
                url: 'https://oauth.example.test/authorize',
                purpose: 'account_directory',
                credentialTarget: 'account_directory',
                endpointUrl: 'https://accounts.example.test',
                endpointServerIdentityId: 'directory-1',
                canonicalServerUrl: 'https://canonical-directory.example.test',
                expiresAt: new Date(now + 60_000).toISOString(),
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        const result = await accountDirectoryAuthClient.startOAuth({
            endpointUrl: 'https://accounts.example.test',
            endpointServerIdentityId: 'directory-1',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            providerId: 'github',
            mode: 'keyless',
            entryIntent: { kind: 'refresh' },
            returnTo: '/settings/account',
        });
        expect(result).toMatchObject({
            url: 'https://oauth.example.test/authorize',
            pending: {
                endpoint: 'https://accounts.example.test',
                serverIdentityId: 'directory-1',
                provider: 'github',
                purpose: 'account_directory',
                credentialTarget: 'account_directory',
                entryIntent: { kind: 'refresh' },
                canonicalServerUrl: 'https://canonical-directory.example.test',
                proof: expect.any(String),
                returnTo: '/settings/account',
            },
        });

        expect(pendingSet).toHaveBeenCalledWith(expect.objectContaining({
            endpoint: 'https://accounts.example.test',
            serverIdentityId: 'directory-1',
            provider: 'github',
            purpose: 'account_directory',
            entryIntent: { kind: 'refresh' },
            canonicalServerUrl: 'https://canonical-directory.example.test',
            proof: expect.any(String),
            returnTo: '/settings/account',
        }));
        expect(pendingSet).toHaveBeenCalledWith(result.pending);
        const persisted = pendingSet.mock.calls[0]?.[0];
        expect(persisted).not.toHaveProperty('secret');
        expect(persisted).not.toHaveProperty('pending');
    });

    it('starts keyed Account Directory creation with a bound local signing key', async () => {
        const now = Date.now();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            expect(url).toContain('mode=keyed');
            expect(url).toContain('publicKey=');
            expect(url).toContain('canonicalServerUrl=https%3A%2F%2Fcanonical-directory.example.test');
            expect(url).not.toContain('proofHash=');
            return new Response(JSON.stringify({
                url: 'https://oauth.example.test/authorize',
                purpose: 'account_directory',
                credentialTarget: 'account_directory',
                endpointUrl: 'https://accounts.example.test',
                endpointServerIdentityId: 'directory-1',
                canonicalServerUrl: 'https://canonical-directory.example.test',
                expiresAt: new Date(now + 60_000).toISOString(),
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        vi.stubGlobal('fetch', fetchMock);
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.startOAuth({
            endpointUrl: 'https://accounts.example.test',
            endpointServerIdentityId: 'directory-1',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            providerId: 'github',
            mode: 'keyed',
            entryIntent: { kind: 'enter', target: { kind: 'automatic' } },
            returnTo: '/setup/wizard',
        })).resolves.toMatchObject({
            url: 'https://oauth.example.test/authorize',
            pending: {
                mode: 'keyed',
                canonicalServerUrl: 'https://canonical-directory.example.test',
                secret: expect.any(String),
            },
        });

        expect(pendingSet).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'keyed',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            secret: expect.any(String),
        }));
        expect(pendingSet.mock.calls[0]?.[0]).not.toHaveProperty('proof');
    });

    it('persists the captured authenticated Home identity intent without credential or descriptor material', async () => {
        const now = Date.now();
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            url: 'https://oauth.example.test/authorize',
            purpose: 'account_directory',
            credentialTarget: 'account_directory',
            endpointUrl: 'https://accounts.example.test',
            endpointServerIdentityId: 'directory-1',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            expiresAt: new Date(now + 60_000).toISOString(),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.startOAuth({
            endpointUrl: 'https://accounts.example.test',
            endpointServerIdentityId: 'directory-1',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            providerId: 'github',
            mode: 'keyed',
            entryIntent: { kind: 'link', homeServerIdentityId: 'srv_home_a' },
            returnTo: '/setup/wizard',
        })).resolves.toMatchObject({
            url: 'https://oauth.example.test/authorize',
            pending: {
                linkHomeServerIdentityId: 'srv_home_a',
            },
        });

        expect(pendingSet).toHaveBeenCalledWith(expect.objectContaining({
            endpoint: 'https://accounts.example.test',
            serverIdentityId: 'directory-1',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            linkHomeServerIdentityId: 'srv_home_a',
        }));
        const persisted = pendingSet.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(Object.keys(persisted)).not.toContain('credentials');
        expect(Object.keys(persisted)).not.toContain('connectionDescriptor');
    });

    it('refuses to start Account Directory OAuth without a known endpoint identity', async () => {
        const { accountDirectoryAuthClient } = await import('./accountDirectoryAuthClient');

        await expect(accountDirectoryAuthClient.startOAuth({
            endpointUrl: 'https://accounts.example.test',
            endpointServerIdentityId: ' ',
            returnTo: '/setup/wizard',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            providerId: 'github',
            mode: 'keyless',
            entryIntent: { kind: 'enter', target: { kind: 'automatic' } },
        })).rejects.toThrow('requires a known endpoint identity');
        expect(pendingSet).not.toHaveBeenCalled();
    });
});
