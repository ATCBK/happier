import React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { KeyChallengeV2IssueResponseSchema } from '@happier-dev/protocol/auth/keyChallenge';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { installRestoreRouteCommonModuleMocks } from '@/__tests__/routes/(app)/restore/restoreRouteTestHelpers';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { authRoutes } from '../../../../../server/sources/app/api/routes/auth/authRoutes';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import type { Fastify as HomeApp } from '../../../../../server/sources/app/api/types';
import { auth as serverAuth } from '../../../../../server/sources/app/auth/auth';

const navigation = vi.hoisted(() => ({ dismissTo: vi.fn(), push: vi.fn(), params: {} as Record<string, string> }));
installTokenStorageWebPlatformMocks();
installRestoreRouteCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        params: () => navigation.params, router: { dismissTo: navigation.dismissTo, push: navigation.push },
    }).module,
});
const { renderScreen } = await import('@/dev/testkit');
const { initializeAuthRouteRuntimeForTests } = await import('@/dev/testkit/harness/authRouteRuntimeHarness');
await initializeAuthRouteRuntimeForTests();
const { AuthProvider, getCurrentAuth } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { authGetTokenAtEndpoint } = await import('@/auth/flows/getToken');
const { encodeBase64 } = await import('@/encryption/base64');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const Screen = (await import('@/app/(app)/restore/manual')).default;
const { RestoreQrView } = await import('./RestoreQrView');

const homeUrl = 'https://signed-out-home-r36.test';
const stackUrl = 'https://stack-home-r36.test';
const homeIdentity = 'srv_signed_out_home_r36';
let database: LightSqliteHarness;
let app: HomeApp;
let storage: ReturnType<typeof installLocalStorageMock>;
let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
const requests: Array<{ origin: string; path: string; status: number }> = [];
// Match vitest.integration.config.ts rather than cutting off Sync's real arrival.
const integrationTimeout = 120_000;

beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-r36-restore-', initAuth: true, initEncrypt: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_AUTH_REQUIRE_KEY_CHALLENGE_V2: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_PUBLIC_SERVER_URL: homeUrl, HAPPIER_SERVER_IDENTITY_ID: homeIdentity } });
    app = createAuthenticatedTestApp({ authentication: 'real' });
    authRoutes(app);
    featuresRoutes(app);
    // Arrival switches the real Sync runtime, which also reads Profile/Settings.
    accountRoutes(app);
    await app.ready();
});

afterEach(async () => {
    await screen?.unmount();
    screen = undefined;
    await disconnectActiveServerConnection();
    setRuntimeFetch(async () => new Response('{}', { status: 404 }));
    vi.unstubAllGlobals();
    storage?.restore();
    navigation.params = {};
    navigation.dismissTo.mockClear();
    navigation.push.mockClear();
});
afterAll(async () => { await app?.close(); await database?.close(); });

it.each([['e2ee', 'standalone'], ['plain', 'standalone'], ['e2ee', 'qr']] as const)
    ('restores the same %s Account through %s after Home-only sign-out', async (mode, ingress) => {
    database.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: mode });
    storage = installLocalStorageMock();
    vi.stubGlobal('window', { location: { origin: 'https://borrowed-ui-r36.test', hostname: 'borrowed-ui-r36.test' },
        __HAPPIER_WEB_RUNTIME_CONFIG__: { serverContext: 'stack', serverUrl: stackUrl } });
    // React-test-renderer has no DOM. Support the shared spinner's CSS insertion
    // at the browser boundary without replacing any restore components.
    vi.stubGlobal('document', { getElementById: () => null,
        createElement: () => ({ id: '', textContent: '' }), head: { appendChild: () => {} } });
    requests.length = 0;
    // Only the HTTP/device/platform boundaries are adapted. Real app routes, strict
    // schemas, proof verification, SQLite, profile store, Auth and Sync remain wired.
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== homeUrl) {
            requests.push({ origin: url.origin, path: url.pathname, status: 503 });
            return Response.json({ error: 'unavailable' }, { status: 503 });
        }
        const headers = Object.fromEntries(new Headers(init?.headers));
        const result = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST',
            url: url.pathname + url.search, headers,
            ...(init?.body ? { payload: String(init.body) } : {}) });
        if (url.pathname === '/v1/features' && result.statusCode === 200) FeaturesResponseSchema.parse(result.json());
        if (url.pathname === '/v1/auth/challenge' && result.statusCode === 200) KeyChallengeV2IssueResponseSchema.parse(result.json());
        requests.push({ origin: url.origin, path: url.pathname, status: result.statusCode });
        return new Response(result.body, { status: result.statusCode, headers: { 'Content-Type': 'application/json' } });
    });
    const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: homeIdentity,
        canonicalServerUrl: homeUrl, revision: 1, endpoints: [{ kind: 'https', url: homeUrl }] },
        source: 'manual', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(home.id, { scope: 'device' });
    const secret = nacl.randomBytes(32);
    const restoredKey = encodeBase64(secret, 'base64url');
    const issued = await authGetTokenAtEndpoint({ endpointUrl: homeUrl, serverId: home.id,
        serverIdentityId: homeIdentity, secret, requireKeyChallengeV2: true });
    const originalAccount = await serverAuth.verifyToken(issued.token);
    expect(originalAccount).not.toBeNull();
    const credentials = mode === 'plain' ? issued : { token: issued.token, secret: restoredKey };
    await TokenStorage.setCredentialsForServerUrl(homeUrl, { serverId: home.id }, credentials);
    screen = await renderScreen(<AuthProvider initialCredentials={credentials}><Screen /></AuthProvider>);
    await act(async () => { expect(await getCurrentAuth()!.logout({ scope: 'focused-home' })).toEqual({ kind: 'completed' }); });
    expect(getActiveServerSnapshot().serverId).toBe(homeIdentity);
    expect(await TokenStorage.getCredentialsForServerUrl(homeUrl, { serverId: home.id })).toBeNull();
    if (ingress === 'qr') {
        const other = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: 'srv_other_home_r36',
            canonicalServerUrl: stackUrl, revision: 1, endpoints: [{ kind: 'https', url: stackUrl }] },
            source: 'manual', descriptorAuthority: 'current_connection_observation' });
        await setActiveServerId(other.id, { scope: 'device' });
        await screen.unmount();
        screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <RestoreQrView embedded entryIntent="enter_home" targetProfileId={homeIdentity} />
        </AuthProvider>);
        await screen.pressByTestIdAsync('restore-open-manual');
        expect(navigation.push).toHaveBeenCalledWith({ pathname: '/restore/manual', params: {
            targetServerId: homeIdentity, targetServerUrl: homeUrl,
        } });
        navigation.params = navigation.push.mock.calls[0][0].params;
        await screen.unmount();
        screen = await renderScreen(<AuthProvider initialCredentials={null}><Screen /></AuthProvider>);
    }
    requests.length = 0;
    await act(async () => { screen!.changeTextByTestId('restore-manual-secret-input', restoredKey); });
    await screen.pressByTestIdAsync('restore-manual-submit');
    await vi.waitFor(async () => {
        await act(async () => {});
        expect(screen!.findByTestId('restore-manual-secret-error')?.props.children ?? null).toBeNull();
        expect(navigation.dismissTo, JSON.stringify({ requests: requests.slice(-25),
            selected: getActiveServerSnapshot(), authenticated: getCurrentAuth()?.isAuthenticated })).toHaveBeenCalledWith('/');
    }, { timeout: integrationTimeout });
    const retained = await TokenStorage.getCredentialsForServerUrl(homeUrl, { serverId: home.id });
    expect(retained).not.toBeNull();
    expect(await serverAuth.verifyToken(retained!.token)).toMatchObject({ userId: originalAccount!.userId });
    expect(retained).toEqual(mode === 'plain' ? { token: retained!.token } : { token: retained!.token, secret: restoredKey });
    expect(getCurrentAuth()?.credentials).toEqual(retained);
    expect(getActiveServerSnapshot().serverId).toBe(homeIdentity);
    expect(requests.filter(request => request.path === '/v1/auth/challenge' || request.path === '/v1/auth'))
        .toEqual([{ origin: homeUrl, path: '/v1/auth/challenge', status: 200 }, { origin: homeUrl, path: '/v1/auth', status: 200 }]);
    expect(await TokenStorage.getCredentialsForServerUrl(stackUrl)).toBeNull();

    // Exact-target ingress must still refuse another key for this Account.
    await act(async () => { expect(await getCurrentAuth()!.logout({ scope: 'focused-home' })).toEqual({ kind: 'completed' }); });
    navigation.params = { targetServerId: homeIdentity, targetServerUrl: homeUrl, expectedAccountId: originalAccount!.userId };
    navigation.dismissTo.mockClear();
    requests.length = 0;
    await screen.unmount();
    screen = await renderScreen(<AuthProvider initialCredentials={null}><Screen /></AuthProvider>);
    await act(async () => { screen!.changeTextByTestId('restore-manual-secret-input', encodeBase64(nacl.randomBytes(32), 'base64url')); });
    await screen.pressByTestIdAsync('restore-manual-submit');
    await vi.waitFor(async () => {
        await act(async () => {});
        expect(screen!.findByTestId('restore-manual-secret-error'),
            JSON.stringify({ requests, pending: screen!.findByTestId('restore-manual-submit')?.props.loading })).not.toBeNull();
    }, { timeout: integrationTimeout });
    expect(screen.findByTestId('restore-manual-secret-error')?.props.children).toBe('errors.authenticationFailed');
    expect(requests.filter(request => request.path === '/v1/auth')).toEqual([{ origin: homeUrl, path: '/v1/auth', status: 401 }]);
    expect(await TokenStorage.getCredentialsForServerUrl(homeUrl, { serverId: homeIdentity })).toBeNull();
    expect(getCurrentAuth()?.isAuthenticated).toBe(false);
    expect(navigation.dismissTo).not.toHaveBeenCalled();
});
