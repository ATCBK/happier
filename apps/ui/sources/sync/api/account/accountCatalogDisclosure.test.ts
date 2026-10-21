import { afterEach, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { fetchAccountEncryptionMode } from './apiAccountEncryptionMode';
import { readSavedSecretReferenceInContext } from './apiSavedSecretCatalog';
import { readRemoteHostCatalogProjectionInContext } from './apiRemoteHostCatalog';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
afterEach(async () => {
    apiSocket.disconnect();
    await resetServerReachabilitySupervisors();
    await home.reset();
    resetRuntimeFetch();
});

const disclosureCases = (['saved-secret', 'remote-host'] as const).flatMap(kind =>
    (['connected', 'reconnect-gap'] as const).map(transport => ({ kind, transport })));
it.each(disclosureCases)('withholds privately opened $kind after committed revocation with publication held ($transport)', async ({ kind, transport }) => {
    const accountId = `${kind}-revocation-${transport}`;
    const serverUrl = `https://${kind}-revocation-${transport}.test`;
    const ref = 'happier:shared-secret:v1:held';
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Held private material', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => {
        socket = current;
        configureConnectedServerSocketBoundary(current);
    });
    let revoked = false;
    let identityAuthorityReads = 0;
    const requested = createDeferred<void>();
    const bodyReady = createDeferred<void>();
    const authorityAfterCommit: string[] = [];
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness') {
            identityAuthorityReads++;
            if (revoked) {
                authorityAfterCommit.push(path);
                return Response.json({ error: 'unauthorized' }, { status: 401 });
            }
            return Response.json(path.endsWith('/currentness') ? createPlainAccountEncryptionCurrentnessFixture()
                : { mode: 'plain', updatedAt: 1 });
        }
        if (path === (kind === 'saved-secret' ? '/v1/account/saved-secrets/resources/materials' : '/v1/account/entity-rows/remote-hosts')) {
            const payload = kind === 'saved-secret' ? { resources: [{ resourceId: 'held', encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: { t: 'plain', v: { v: 1, name: 'Held', kind: 'token', value: 'must-stay-private' } },
                entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Held', kind: 'token', revision: 1,
                    materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] }
                : { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, hosts: [{ id: 'held-host', name: 'Private host',
                    ssh: { target: 'private@example.test', authMode: 'agent' }, createdAt: 1, updatedAt: 1, lastUsedAt: null }] } } };
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                requested.resolve(undefined);
                void bodyReady.promise.then(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); });
            } }), { headers: { 'Content-Type': 'application/json' } });
        }
        return home.request(rawUrl, init);
    });
    const lifetime = new AbortController();
    const captured = await captureLazyActionAccountContext(serverId, lifetime.signal);
    try {
        const admittedCredentials = captured.credentials;
        const initialRequest = createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials: admittedCredentials });
        apiSocket.initialize({ endpoint: serverUrl, token: admittedCredentials.token, credentials: admittedCredentials,
            serverId, generation: getActiveServerSnapshot().generation, request: initialRequest,
            isCurrent: captured.accountLifetime.isCurrent }, null);
        await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
        const binding = apiSocket.getAccountEncryptionObservationBinding(admittedCredentials);
        expect(binding).not.toBeNull();
        const request = createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials: admittedCredentials,
            signal: lifetime.signal, isCurrent: captured.accountLifetime.isCurrent, accountEncryptionObservation: binding ?? undefined });
        const resolveAccountMode = async () => (await fetchAccountEncryptionMode(admittedCredentials, { request, usage: 'identity' })).mode;
        // Keep the real Action capture/currentness and use the exact admitted
        // Socket binding on its real captured HTTP transport.
        const context = { ...captured, request };
        expect(await resolveAccountMode()).toBe('plain');
        expect(identityAuthorityReads).toBe(1);
        const warmedAuthorityReads = identityAuthorityReads;
        expect(await resolveAccountMode()).toBe('plain');
        // Prove this is a borrowed observation, not the unbranded HTTP fallback.
        expect(identityAuthorityReads).toBe(warmedAuthorityReads);
        let published = false;
        const read = kind === 'saved-secret' ? readSavedSecretReferenceInContext(context, ref)
            : readRemoteHostCatalogProjectionInContext(context, undefined, {
                onReady: () => { published = true; }, hasPendingCleanup: () => true,
            });
        await Promise.race([requested.promise, read.then(() => { throw new Error('Reader completed before its private response body was held'); })]);
        // The authority boundary now models a committed token epoch change.
        // Neither an Account push nor a server disconnect has been delivered.
        revoked = true;
        if (transport === 'reconnect-gap') {
            socket!.disconnect();
            socket!.connect();
        }
        bodyReady.resolve(undefined);
        await expect(read).resolves.toMatchObject(kind === 'saved-secret' ? { ok: false } : { status: 'unavailable' });
        expect(published).toBe(false);
        expect(authorityAfterCommit).toContain(kind === 'saved-secret' ? '/v1/account/encryption' : '/v1/account/encryption/currentness');
    } finally { bodyReady.resolve(undefined); lifetime.abort(); captured.dispose(); }
});
