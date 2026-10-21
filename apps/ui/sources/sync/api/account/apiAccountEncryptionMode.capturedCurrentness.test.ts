import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { fetchAccountEncryptionCurrentness } from './apiAccountEncryptionMode';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import type { Socket } from 'socket.io-client';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { fetchAccountEncryptionMode } from './apiAccountEncryptionMode';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
beforeAll(loadSyncSingletonForTests);
afterEach(async () => {
    apiSocket.disconnect();
    await resetServerReachabilitySupervisors();
    await home.reset();
    resetRuntimeFetch();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it.each(['matching', 'different', 'disconnected'] as const)('admits captured Action identity only through its live resolved carrier (%s)', async carrier => {
    const accountId = `captured-carrier-${carrier}`;
    const serverUrl = `https://captured-carrier-${carrier}.test`;
    const runtimeOrigin = carrier === 'different' ? 'https://different-observed-ingress.test' : serverUrl;
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Captured carrier', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    const authorityReads: URL[] = [];
    setRuntimeFetch(async (rawUrl, init) => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/v1/account/encryption' || url.pathname === '/v1/account/encryption/currentness') {
            authorityReads.push(url);
            return Response.json(url.pathname.endsWith('/currentness') ? createPlainAccountEncryptionCurrentnessFixture()
                : { mode: 'plain', updatedAt: 1 });
        }
        return home.request(rawUrl, init);
    });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => {
        socket = current;
        if (carrier !== 'disconnected') configureConnectedServerSocketBoundary(current);
    });
    apiSocket.initialize({ endpoint: serverUrl, runtimeOrigin, token: credentials.token, credentials, serverId,
        generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, runtimeOrigin, serverId, credentials }),
        isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(carrier !== 'disconnected'));
    if (carrier !== 'disconnected') {
        await expect(fetchAccountEncryptionMode(credentials)).resolves.toMatchObject({ mode: 'plain' });
        expect(authorityReads.map(url => url.pathname)).toEqual(['/v1/account/encryption/currentness']);
    }
    authorityReads.length = 0;
    const preparedRequest = apiSocket.createRequestForPreparedTarget({ endpoint: serverUrl, runtimeOrigin, serverId,
        generation: getActiveServerSnapshot().generation });
    await expect(fetchAccountEncryptionMode(credentials, { request: preparedRequest, usage: 'identity' })).resolves.toMatchObject({ mode: 'plain' });
    expect(authorityReads.map(url => [url.origin, url.pathname])).toEqual(carrier === 'disconnected'
        ? [[serverUrl, '/v1/account/encryption']] : []);
    authorityReads.length = 0;
    const invocation = new AbortController();
    const context = await captureLazyActionAccountContext(serverId, invocation.signal);
    try {
        expect(authorityReads).toHaveLength(0);
        await expect(context.resolveAccountMode()).resolves.toBe('plain');
        expect(authorityReads.map(url => [url.origin, url.pathname])).toEqual(carrier === 'matching' ? []
            : [[serverUrl, '/v1/account/encryption']]);
        authorityReads.length = 0;
        await expect(fetchAccountEncryptionCurrentness(context.credentials, { request: context.request }))
            .resolves.toMatchObject({ mode: 'plain' });
        expect(authorityReads.map(url => [url.origin, url.pathname])).toEqual([[serverUrl, '/v1/account/encryption/currentness']]);
        invocation.abort();
        await expect(fetchAccountEncryptionMode(context.credentials, { request: context.request, usage: 'identity' })).rejects.toThrow();
        expect(context.accountLifetime.isCurrent()).toBe(false);
        expect(context.accountOnlyLifetime.isCurrent()).toBe(true);
    } finally { context.dispose(); }
});

it('keeps captured-Home readiness failure out of the selected Home recovery flow', async () => {
    await upsertAndActivateServer({ serverUrl: 'https://selected-currentness.test' });
    const credentials = { token: 'captured-token', secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: 'migration-required',
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
    }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = createServerFetchAtEndpoint({ endpointUrl: 'https://captured-currentness.test', credentials });
    await expect(fetchAccountEncryptionCurrentness(credentials, { request })).rejects.toMatchObject({
        code: 'account-encryption-currentness-unavailable',
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).origin).toBe('https://captured-currentness.test');
});
