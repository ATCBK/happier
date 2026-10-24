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
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createOperationAccountCurrentnessSource } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { invalidateAccountEncryptionModeCache } from './apiAccountEncryptionMode';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';

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

it.each(['unchanged', 'intentional-disconnect', 'mode', 'fingerprint', 'update', 'malformed-update', 'scope-reset', 'credential-retired', 'home-retired', 'fresh-denied'] as const)(
    'revalidates finite Session hydration across socket loss (%s)', async outcome => {
    const accountId = `finite-${outcome}`;
    const serverUrl = `https://finite-${outcome}.test`;
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Finite Session', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    let currentness: AccountEncryptionCurrentnessResponse = createPlainAccountEncryptionCurrentnessFixture();
    let denied = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let detailStarted = false;
    const sessionId = 'finite-session';
    setRuntimeFetch(createSessionReadBatchFetchBoundary(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption/currentness') return denied
            ? Response.json({ error: 'forbidden' }, { status: 403 }) : Response.json(currentness);
        if (path === `/v2/sessions/${sessionId}`) {
            detailStarted = true;
            await held;
            return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) });
        }
        if (path === `/v1/sessions/${sessionId}/turns`) return Response.json({ v: 1, sessionId, updatedAt: 1, turns: [] });
        return home.request(rawUrl, init);
    }));
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    const request = createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials });
    apiSocket.initialize({ endpoint: serverUrl, serverId, token: credentials.token, credentials,
        generation: getActiveServerSnapshot().generation, request, isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const context = await captureLazyActionAccountContext(serverId);
    let operationReads = 0;
    const explicitCredentials: string[] = [];
    const source = createOperationAccountCurrentnessSource({ credentials, serverId,
        request: (path, init) => {
            operationReads += 1;
            explicitCredentials.push(new Headers(init.headers).get('Authorization') ?? '');
            return context.request(path, init);
        } });
    try {
        await source.read();
        const reading = runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope,
            activeRequest: context.request }, authority => readSessionSnapshotForAuthority({ authority, sessionId,
                accountCurrentnessSource: source, isCurrent: context.accountLifetime.isCurrent }))
            .then(value => ({ value }), (error: unknown) => ({ error }));
        await waitForHomeGovernance(() => expect(detailStarted).toBe(true));
        socket!.connected = false;
        for (const listener of socket!.listeners('disconnect')) listener('ping timeout');
        if (outcome === 'mode') currentness = { ...currentness, mode: 'e2ee', signingKeyFingerprint: 'signing-new',
            contentKeyFingerprint: 'content-new', recipientEnvelopeReadiness: { status: 'available' } };
        if (outcome === 'fingerprint') currentness = { ...currentness, signingKeyFingerprint: 'changed-anchor' };
        denied = outcome === 'fresh-denied';
        socket!.connect();
        if (outcome === 'update' || outcome === 'malformed-update') {
            const update = { id: 'encryption-change', seq: 2, createdAt: 2,
                body: { t: 'update-account', id: accountId, encryptionCurrentness: outcome === 'update'
                    ? { ...currentness, updatedAt: 2, version: 2 } : { mode: 'plain' } } };
            for (const listener of socket!.listenersAny()) listener('update', update);
        }
        if (outcome === 'scope-reset') invalidateAccountEncryptionModeCache({ reason: 'scope-reset' });
        if (outcome === 'intentional-disconnect') apiSocket.disconnect();
        if (outcome === 'credential-retired' || outcome === 'home-retired') {
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId });
            if (outcome === 'home-retired') {
                const { removeServerProfile } = await import('@/sync/domains/server/serverProfiles');
                await removeServerProfile(serverId);
            }
        }
        release();
        const result = await reading;
        if (outcome === 'unchanged' || outcome === 'intentional-disconnect') {
            expect(result).toMatchObject({ value: { session: { id: sessionId } } });
            expect(source.isCurrent()).toBe(true);
            expect(operationReads).toBe(2);
            await Promise.all([source.read(), source.read()]);
            expect(operationReads).toBe(2);
            expect(explicitCredentials).toEqual([`Bearer ${credentials.token}`, `Bearer ${credentials.token}`]);
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            await expect(TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId })).resolves.toEqual(credentials);
        } else {
            expect(result).toHaveProperty('error');
            if (['mode', 'fingerprint', 'update', 'malformed-update', 'scope-reset'].includes(outcome)) {
                // A previously retired capture is refused by the Snapshot
                // reader before hydration; a fresh-read mismatch reaches the
                // finite currentness owner's more specific typed error.
                expect(result).toMatchObject({ error: outcome === 'mode' || outcome === 'fingerprint'
                    ? { code: 'account_encryption_currentness_changed' }
                    : { name: 'SessionSnapshotReadError', errorCode: 'stale_response' } });
                expect(source.isCurrent()).toBe(false);
                expect(source.assertCurrent).toThrow(expect.objectContaining({ code: 'account_encryption_currentness_changed' }));
            }
        }
    } finally { release(); source.dispose(); context.dispose(); }
});

it('shares the fresh replacement of a withdrawn pending finite currentness read', async () => {
    const initial = createPlainAccountEncryptionCurrentnessFixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    const source = createOperationAccountCurrentnessSource({ credentials: { token: 'finite-pending' }, initial,
        request: async () => {
            requests += 1;
            const version = requests + 1;
            if (requests === 1) await held;
            return Response.json(createPlainAccountEncryptionCurrentnessFixture({ version }));
        } });
    try {
        invalidateAccountEncryptionModeCache({ reason: 'transport-withdrawal' });
        const first = source.read();
        expect(requests).toBe(1);
        invalidateAccountEncryptionModeCache({ reason: 'transport-withdrawal' });
        const second = source.read();
        expect(requests).toBe(1);
        release();
        const results = await Promise.all([first, second]);
        expect(results.map(result => result.version)).toEqual([3, 3]);
        expect(requests).toBe(2);
    } finally { release(); source.dispose(); }
});
