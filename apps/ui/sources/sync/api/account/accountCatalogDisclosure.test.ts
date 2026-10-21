import { afterEach, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import tweetnacl from 'tweetnacl';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { encodeBase64 } from '@/encryption/base64';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
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
import { readRemoteHostCatalog, readRemoteHostCatalogProjection, readRemoteHostCatalogProjectionInContext } from './apiRemoteHostCatalog';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();
afterEach(async () => {
    apiSocket.disconnect();
    await resetServerReachabilitySupervisors();
    await home.reset();
    resetRuntimeFetch();
});

it.each(['cold', 'warm'] as const)('enters the RemoteHost scope admission only once (%s identity)', async warmth => {
    const accountId = `remote-host-single-admission-${warmth}`;
    const serverUrl = `https://remote-host-single-admission-${warmth}.test`;
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'One RemoteHost admission', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    let rowRead = false;
    const initialAuthority: string[] = [];
    const finalAuthority: string[] = [];
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness') {
            (rowRead ? finalAuthority : initialAuthority).push(path);
            return Response.json(path.endsWith('/currentness') ? createPlainAccountEncryptionCurrentnessFixture()
                : { mode: 'plain', updatedAt: 1 });
        }
        if (path === '/v1/account/entity-rows/remote-hosts') {
            rowRead = true;
            return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, hosts: [] } } });
        }
        return home.request(rawUrl, init);
    });
    if (warmth === 'warm') {
        let socket: Socket | undefined;
        installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
        apiSocket.initialize({ endpoint: serverUrl, token: credentials.token, credentials, serverId,
            generation: getActiveServerSnapshot().generation,
            request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials }), isCurrent: () => true }, null);
        await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
        const warm = await captureLazyActionAccountContext(serverId);
        try { await expect(warm.resolveAccountMode()).resolves.toBe('plain'); }
        finally { warm.dispose(); }
        expect(initialAuthority).toEqual(['/v1/account/encryption/currentness']);
        initialAuthority.length = 0;
    }
    // This is the production scope entry, not a manually branded test context.
    await expect(readRemoteHostCatalog({ serverId, accountId })).resolves.toMatchObject({ status: 'ready', hosts: [] });
    expect(initialAuthority).toEqual(warmth === 'warm' ? [] : ['/v1/account/encryption', '/v1/account/encryption/currentness']);
    expect(finalAuthority).toEqual(['/v1/account/encryption/currentness']);
});

it.each(['none', 'pending', 'cleanup'] as const)('reuses the last RemoteHost publication admission for its return (%s publication)', async publication => {
    const accountId = `remote-host-publication-count-${publication}`;
    const serverUrl = `https://remote-host-publication-count-${publication}.test`;
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'One return admission', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    let opened = false;
    let finalAuthorityReads = 0;
    const publications: number[] = [];
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') {
            if (opened) finalAuthorityReads++;
            return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }));
        }
        if (path === '/v1/account/entity-rows/remote-hosts') {
            opened = true;
            return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, hosts: [] } } });
        }
        if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
        if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
        if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
        return home.request(rawUrl, init);
    });
    await expect(readRemoteHostCatalogProjection({ serverId, accountId }, undefined, {
        ...(publication !== 'cleanup' ? { hasPendingCleanup: () => true } : {}),
        ...(publication !== 'none' ? { onReady: () => { publications.push(finalAuthorityReads); } } : {}),
    })).resolves.toMatchObject({ status: 'ready', hosts: [] });
    if (publication === 'none') expect(finalAuthorityReads).toBe(1);
    else {
        expect(publications).toHaveLength(publication === 'cleanup' ? 2 : 1);
        if (publication === 'pending') expect(finalAuthorityReads).toBe(1);
        // No private work follows the last awaited publication, so returning
        // that same result must not acquire a third authority observation.
        expect(finalAuthorityReads).toBe(publications.at(-1));
    }
});

it.each([401, 403])('retains typed RemoteHost publication refusal without an external callback (%s)', async status => {
    const accountId = `remote-host-typed-publication-${status}`;
    const serverUrl = `https://remote-host-typed-publication-${status}.test`;
    const serverId = await home.addHome({ name: 'Typed refusal', serverUrl, accountId,
        credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
        accountEncryptionMode: 'plain', currentAccount: true });
    let opened = false;
    let refusedReads = 0;
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') {
            if (opened) { refusedReads++; return Response.json({}, { status }); }
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        if (path === '/v1/account/entity-rows/remote-hosts') {
            opened = true;
            return Response.json({}, { status });
        }
        return home.request(rawUrl, init);
    });
    await expect(readRemoteHostCatalogProjection({ serverId, accountId }, undefined, { hasPendingCleanup: () => true }))
        .resolves.toEqual({ status: 'unavailable', reason: status === 401 ? 'unauthorized' : 'forbidden' });
    expect(refusedReads).toBe(1);
});

const disclosureCases = (['saved-secret', 'remote-host'] as const).flatMap(kind =>
    (['connected', 'reconnect-gap'] as const).map(transport => ({ kind, transport, authority: 'revoked' as const })));
const encryptedCases = (['matching', 'fingerprint-changed', 'revoked'] as const).map(authority => ({
    kind: 'encrypted-secret' as const, transport: 'connected' as const, authority,
}));
it.each([...disclosureCases, ...encryptedCases])('admits privately opened $kind through held publication ($transport, $authority)', async ({ kind, transport, authority }) => {
    const accountId = `${kind}-${authority}-${transport}`;
    const serverUrl = `https://${kind}-${authority}-${transport}.test`;
    const ref = 'happier:shared-secret:v1:held';
    const encrypted = kind === 'encrypted-secret';
    const token = createAccountTokenForTests(accountId, { currentAccount: true });
    const credentials = encrypted ? { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') } : { token };
    const encryption = encrypted ? await createEncryptionFromAuthCredentials(credentials) : null;
    const material = encrypted ? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : null;
    const fingerprint = material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint) : null;
    const changedFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(
        tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(25)).publicKey);
    const resourceDataKey = new Uint8Array(32).fill(19);
    const accountMode = encrypted ? 'e2ee' : 'plain';
    const serverId = await home.addHome({ name: 'Held private material', serverUrl, accountId, credentials,
        accountEncryptionMode: accountMode, currentAccount: true });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => {
        socket = current;
        configureConnectedServerSocketBoundary(current);
    });
    let committed = false;
    let identityAuthorityReads = 0;
    const requested = createDeferred<void>();
    const bodyReady = createDeferred<void>();
    const authorityAfterCommit: string[] = [];
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness') {
            identityAuthorityReads++;
            if (committed) authorityAfterCommit.push(path);
            if (committed && authority === 'revoked') {
                return Response.json({ error: 'unauthorized' }, { status: 401 });
            }
            return Response.json(path.endsWith('/currentness') ? encrypted ? { mode: 'e2ee', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: committed && authority === 'fingerprint-changed'
                    ? changedFingerprint : fingerprint, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } }
                : createPlainAccountEncryptionCurrentnessFixture() : { mode: accountMode, updatedAt: 1 });
        }
        if (path === (kind !== 'remote-host' ? '/v1/account/saved-secrets/resources/materials' : '/v1/account/entity-rows/remote-hosts')) {
            const content = { v: 1 as const, name: 'Held', kind: 'token' as const, value: 'must-stay-private' };
            const payload = kind !== 'remote-host' ? { resources: [{ resourceId: 'held', encryptionMode: accountMode,
                recipientEnvelope: encryption ? { encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                    dataKey: resourceDataKey, recipientPublicKey: encryption.contentDataKey, randomBytes: tweetnacl.randomBytes }), 'base64'),
                    recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey) } : null,
                storedContent: encrypted ? sealSavedSecretResourceStoredContentV1({ resourceId: 'held', mode: 'e2ee',
                    resourceDataKey, content, randomBytes: tweetnacl.randomBytes }) : { t: 'plain', v: content },
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
        expect(await resolveAccountMode()).toBe(accountMode);
        expect(identityAuthorityReads).toBe(1);
        const warmedAuthorityReads = identityAuthorityReads;
        expect(await resolveAccountMode()).toBe(accountMode);
        // Prove this is a borrowed observation, not the unbranded HTTP fallback.
        expect(identityAuthorityReads).toBe(warmedAuthorityReads);
        let published = false;
        const read = kind !== 'remote-host' ? readSavedSecretReferenceInContext(context, ref)
            : readRemoteHostCatalogProjectionInContext(context, undefined, {
                onReady: () => { published = true; }, hasPendingCleanup: () => true,
            });
        await Promise.race([requested.promise, read.then(() => { throw new Error('Reader completed before its private response body was held'); })]);
        // The authority boundary now models a committed token epoch change.
        // Neither an Account push nor a server disconnect has been delivered.
        committed = true;
        if (transport === 'reconnect-gap') {
            socket!.disconnect();
            socket!.connect();
        }
        bodyReady.resolve(undefined);
        await expect(read).resolves.toMatchObject(authority === 'matching' ? { ok: true, value: 'must-stay-private', revision: 1 }
            : kind !== 'remote-host' ? { ok: false } : { status: 'unavailable' });
        expect(published).toBe(false);
        if (encrypted) expect(authorityAfterCommit).toEqual(['/v1/account/encryption/currentness']);
        else expect(authorityAfterCommit).toContain(kind === 'saved-secret' ? '/v1/account/encryption' : '/v1/account/encryption/currentness');
    } finally { bodyReady.resolve(undefined); lifetime.abort(); captured.dispose(); }
});
