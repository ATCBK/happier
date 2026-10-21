import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, setActiveServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { captureActionAccountContext, captureLazyActionAccountContext } from './actionAccountContext';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { createDeferred } from '@/dev/testkit';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { computeContentPublicKeyFingerprint, openEncryptedDataKeyEnvelopeV1, signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

let homes: Awaited<ReturnType<typeof serveAccountHomes>>;
let accountMode: 'plain' | 'e2ee';
const network = vi.fn<(url: URL, init?: RequestInit) => Promise<Response>>();
beforeEach(async () => {
    retireActiveServerAccountScopeLifetime();
    accountMode = 'plain';
    homes = await serveAccountHomes({ homes: [
        { key: 'e', serverUrl: 'https://home-e.example.test', accountId: 'account-a', accountMode: 'e2ee',
            credentials: { token: createAccountTokenForTests('account-a'), secret: Buffer.alloc(32, 7).toString('base64url') } },
        { key: 'c', serverUrl: 'https://home-c.example.test', accountId: 'account-a' },
        { key: 'b', serverUrl: 'https://home-b.example.test', accountId: 'account-a' },
        { key: 'a', serverUrl: 'https://home-a.example.test', accountId: 'account-a' },
    ], route: () => undefined });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    network.mockReset();
    network.mockImplementation(async (url, init) => url.pathname === '/v1/account/encryption'
        ? Response.json({ mode: url.origin === 'https://home-e.example.test' ? 'e2ee' : accountMode, updatedAt: 1 }) : homes.fetch(url, init));
    setRuntimeFetch(async (input, init) => network(new URL(String(input)), init));
});
afterEach(async () => {
    retireActiveServerAccountScopeLifetime();
    publishAppliedActiveServerRuntimeAvailability(false);
    await homes?.dispose();
});

it('retains original Account-only cleanup custody after user cancellation, but not Account retirement', async () => {
    const cancellation = new AbortController();
    const account = await captureLazyActionAccountContext(homes.homes.a!.id, cancellation.signal);
    try {
        cancellation.abort();
        expect(account.accountLifetime.isCurrent()).toBe(false);
        expect(account.accountOnlyLifetime.isCurrent()).toBe(true);
        expect(() => account.assertAccountCurrent()).not.toThrow();
        retireActiveServerAccountScopeLifetime();
        expect(account.accountOnlyLifetime.isCurrent()).toBe(false);
        expect(() => account.assertAccountCurrent()).toThrow('action_account_scope_changed');
    } finally { account.dispose(); }
});

describe('captureActionAccountContext encryption authority', () => {
    it('exposes no fabricated encryption material for a Plain Account', async () => {
        const context = await captureActionAccountContext(homes.homes.a!.id);
        try {
            expect(context.encryption).toBeNull();
            expect('secret' in context.credentials || 'encryption' in context.credentials).toBe(false);
        } finally { context.dispose(); }
    });
    it('exposes the exact encryption instance resolved for the captured E2EE Home', async () => {
        const context = await captureActionAccountContext(homes.homes.e!.id);
        try {
            expect(context.encryption).toBeInstanceOf(Encryption);
            if (!context.encryption) throw new Error('Missing Account encryption');
            const value = { literal: 'original Home', binary: [0, 255, 128] };
            expect(await context.encryption.decryptRaw(await context.encryption.encryptRaw(value))).toEqual(value);
        } finally { context.dispose(); }
    });
    it('fails an E2EE Account closed when its actual credential has no encryption material', async () => {
        accountMode = 'e2ee';
        await expect(captureActionAccountContext(homes.homes.a!.id)).rejects.toThrow('Account encryption material is unavailable');
    });
});

describe('captureLazyActionAccountContext encryption on demand', () => {
    it('reads a fresh recipient audience after a committed grant while an earlier read is still pending', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const dataKey = new Uint8Array(32).fill(52);
        const codec = new ArtifactEncryption(dataKey);
        const dataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(dataKey));
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const artifact = { id: artifactId, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey, publicAudience: 'none', header: await codec.encryptHeader({ title: 'Shared document' }),
            body: await codec.encryptBody({ body: 'Current content' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const signingSecret = new Uint8Array(32).fill(53);
        const signingPublic = ed25519.getPublicKey(signingSecret);
        const recipientSecret = new Uint8Array(32).fill(54);
        const recipientPublic = x25519.getPublicKey(recipientSecret);
        const fingerprint = computeContentPublicKeyFingerprint(recipientPublic);
        const signature = signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]),
            contentPublicKey: recipientPublic });
        const recipient = { recipientAccountId: 'recipient', contentKey: { status: 'available',
            accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'), contentPublicKey: encodeBase64(recipientPublic),
            contentPublicKeySignature: encodeBase64(signature) }, contentPublicKeyFingerprint: fingerprint,
            encryptedDataKey: null, recipientContentPublicKeyFingerprint: null };
        const oldReadStarted = createDeferred<void>();
        const releaseOldRead = createDeferred<void>();
        let granted = false;
        let reads = 0;
        let prepared = 0;
        network.mockImplementation(async (url, init) => {
            const path = url.pathname;
            if (path === '/v1/features') return Response.json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === `/v1/artifacts/${artifactId}/access/grants` && init?.method === 'PUT') {
                granted = true;
                return Response.json({ artifactId, ownerAccountId: 'account-a', access: 'owner', changed: true, grants: [{
                    principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view', createdByAccountId: 'account-a',
                    createdAt: 1, display: { name: null },
                }] });
            }
            if (path === '/v1/artifacts/read') {
                reads++;
                const census = { artifactId, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'e2ee',
                    dataEncryptionKey, callerDataEncryptionKey: dataEncryptionKey, recipients: granted ? [recipient] : [] };
                if (reads === 1) { oldReadStarted.resolve(); await releaseOldRead.promise; }
                return Response.json({ items: [{ artifactId, ok: true, artifact, recipientCensus: census }] });
            }
            if (path === `/v1/artifacts/${artifactId}/access/key-envelopes`) {
                const commit = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse(JSON.parse(String(init?.body)));
                expect(commit.recipientKeyEnvelopes.map(item => item.recipientAccountId)).toEqual(['recipient']);
                expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(commit.recipientKeyEnvelopes[0]!.encryptedDataKey),
                    recipientSecretKeyOrSeed: recipientSecret })).toEqual(dataKey);
                prepared++;
                return Response.json({ appliedRecipientAccountIds: ['recipient'], skippedRecipientAccountIds: [] });
            }
            return homes.fetch(url, init);
        });
        const reader = await captureLazyActionAccountContext(homes.homes.e!.id);
        const writer = await captureLazyActionAccountContext(homes.homes.e!.id);
        let oldRead: Promise<unknown> | undefined;
        let grant: Promise<unknown> | undefined;
        try {
            await Promise.all([reader.resolveAccountEncryption(), writer.resolveAccountEncryption()]);
            oldRead = reader.readArtifact(artifactId);
            await oldReadStarted.promise;
            grant = writer.artifactAccessGrants.set({ artifactId, principal: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view' });
            await vi.waitFor(() => expect(reads).toBe(2));
            await expect(grant).resolves.toMatchObject({ changed: true });
            expect(granted).toBe(true);
            expect(prepared).toBe(1);
        } finally {
            releaseOldRead.resolve();
            await Promise.allSettled([oldRead, grant]);
            reader.dispose(); writer.dispose();
        }
    });

    it('returns committed self-revocation without opening the now-inaccessible Artifact', async () => {
        const revoked = { artifactId: 'artifact', ownerAccountId: 'owner', access: null, grants: [], changed: true };
        network.mockImplementation(async (url, init) => url.pathname.startsWith('/v1/artifacts/')
            ? init?.method === 'DELETE' ? Response.json(revoked) : Response.json({ error: 'Artifact not found' }, { status: 404 })
            : homes.fetch(url, init));
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            await expect(context.artifactAccessGrants.remove({ artifactId: 'artifact', principal: { kind: 'account', accountId: 'account-a' } })).resolves.toEqual(revoked);
            const artifactCalls = network.mock.calls.filter(([url]) => url.pathname.startsWith('/v1/artifacts/'));
            expect(artifactCalls).toHaveLength(1);
            expect(artifactCalls[0]?.[1]?.method).toBe('DELETE');
            expect(storage.getState().artifacts.artifact).toBeUndefined();
        } finally { context.dispose(); }
    });
    it('binds the Home and Account without reading the encryption mode or deriving keys', async () => {
        const context = await captureLazyActionAccountContext(homes.homes.e!.id);
        try {
            expect(context.accountId).toBe('account-a');
            const encryptionReads = () => network.mock.calls.filter(([url]) =>
                url.origin === 'https://home-e.example.test' && url.pathname === '/v1/account/encryption');
            expect(encryptionReads()).toHaveLength(0);
            const first = await context.resolveAccountEncryption();
            expect(await context.resolveAccountEncryption()).toBe(first);
            expect(first.accountMode).toBe('e2ee');
            expect(first.encryption).toBeInstanceOf(Encryption);
            expect(encryptionReads()).toHaveLength(1);
        } finally { context.dispose(); }
    });
    it('fails a mode-dependent operation closed when the Account encryption mode cannot be read', async () => {
        network.mockImplementation(async (url, init) => {
            if (url.pathname === '/v1/account/encryption') throw new Error('encryption_mode_unavailable');
            return homes.fetch(url, init);
        });
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            await expect(context.resolveAccountEncryption()).rejects.toThrow('encryption_mode_unavailable');
            await expect(context.fetchArtifact('artifact-a')).rejects.toThrow('encryption_mode_unavailable');
            expect(network.mock.calls.filter(([url]) => url.pathname.startsWith('/v1/artifacts/'))).toHaveLength(0);
        } finally { context.dispose(); }
    });
});

describe('captureActionAccountContext transport authority', () => {
    it('preserves a mutation acknowledgement when retirement arrives during the response', async () => {
        const response = Response.json({ committed: true });
        network.mockImplementation(async (url, init) => {
            if (url.pathname !== '/v1/artifacts' || init?.method !== 'POST') return homes.fetch(url, init);
            retireActiveServerAccountScopeLifetime();
            return response;
        });
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            await expect(context.request('/v1/artifacts', { method: 'POST', body: '{}' })).resolves.toBe(response);
            expect(context.accountLifetime.isCurrent()).toBe(false);
            await expect(context.request('/v1/artifacts', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        } finally { context.dispose(); }
    });
    it('does not return read content when its Account retires while awaiting the response', async () => {
        const path = '/v1/artifacts/11111111-1111-4111-8111-111111111111';
        network.mockImplementation(async (url, init) => {
            if (url.pathname !== path) return homes.fetch(url, init);
            retireActiveServerAccountScopeLifetime();
            return Response.json({ private: true });
        });
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try { await expect(context.request(path)).rejects.toMatchObject({ code: 'action_account_scope_changed' }); }
        finally { context.dispose(); }
    });
    it('does not retire the mounted Home lifetime while the next Home is only staged', async () => {
        const mountedA = captureActiveServerAccountScopeLifetime();
        expect(mountedA?.isCurrent()).toBe(true);
        await setActiveServer({ serverId: homes.homes.b!.id });
        const stagedB = await captureLazyActionAccountContext(homes.homes.b!.id);
        const appliedA = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            expect(captureActiveServerAccountScopeLifetime()).toBe(mountedA);
            expect(() => appliedA.assertCurrent()).not.toThrow();
            storage.setState({ profileScope: { serverId: homes.homes.b!.id, accountId: 'account-a' } });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const establishedB = await captureLazyActionAccountContext(homes.homes.b!.id);
            try {
                await setActiveServer({ serverId: homes.homes.a!.id });
                expect(() => establishedB.assertCurrent()).not.toThrow();
                publishAppliedActiveServerRuntimeAvailability(false);
                expect(() => establishedB.assertCurrent()).toThrow('action_account_scope_changed');
            } finally { establishedB.dispose(); }
        } finally { stagedB.dispose(); appliedA.dispose(); }
    });
    it('keeps applied, staged, and background Homes on their scoped target transport during a focus switch', async () => {
        await setActiveServer({ serverId: homes.homes.b!.id });
        const contexts = await Promise.all(['a', 'b', 'c'].map(key => captureLazyActionAccountContext(homes.homes[key]!.id)));
        try {
            await Promise.all(contexts.map((context, i) => context.request('/action-' + i)));
            expect(network.mock.calls.filter(([url]) => url.pathname.startsWith('/action-')).map(([url]) => url.origin).sort())
                .toEqual(['https://home-a.example.test', 'https://home-b.example.test', 'https://home-c.example.test']);
            expect(network.mock.calls.filter(([url]) => url.pathname.startsWith('/action-')).every(([, init]) => new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '))).toBe(true);
        } finally { contexts.forEach(context => context.dispose()); }
    });
});
