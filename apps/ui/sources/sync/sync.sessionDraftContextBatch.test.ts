import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createSessionDraftPrivatePayloadV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { computeAccountEncryptionMigrateKeyFingerprintV1, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// Keep the real draft persistence adapter/merge; replace only device record
// transactions so the controlled retry clock cannot block IndexedDB tasks.
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

// Install network boundaries before the real Sync graph; load that graph once
// during collection instead of resetting and importing it inside a timed hook.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const drafts = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { storage } = await import('./domains/state/storage');
const { profileDefaults } = await import('./domains/profiles/profile');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');

beforeEach(() => network.resetRequests());

afterAll(async () => {
    await disconnectActiveServerConnection();
    await network.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('Session draft collection context batching', () => {
    it.each(['plain', 'e2ee'] as const)('opens a %s draft page with one admitted batch for missing Session contexts and reuses retained context', async accountMode => {
        const secret = new Uint8Array(32).fill(17);
        const accountId = `draft-context-${accountMode}`;
        const credentials = { token: createAccountTokenForTests(accountId),
            ...(accountMode === 'e2ee' ? { secret: encodeBase64(secret, 'base64url') } : {}) };
        const home = await network.addHome(`https://draft-context-${accountMode}.example.test`, accountId,
            { credentials, encryptionMode: accountMode });
        const authorEncryption = await Encryption.create(secret);
        authorEncryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const keys = new Map<string, Uint8Array>(['retained', 'missing-a', 'missing-b'].map((suffix, index) =>
            [`draft-context-${suffix}`, new Uint8Array(32).fill(index + 3)]));
        await authorEncryption.initializeSessions(keys);
        const envelopes = new Map(await Promise.all([...keys].map(async ([id, key]) =>
            [id, encodeBase64(await authorEncryption.encryptEncryptionKey(key), 'base64')] as const)));
        const row = (sessionId: string) => ({ ...createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }),
            ...(accountMode === 'e2ee' ? { encryptionMode: 'e2ee', dataEncryptionKey: envelopes.get(sessionId),
                metadataLayoutVersion: 0, ownerMetadata: undefined, metadata: 'metadata-not-demanded', agentState: 'state-not-demanded' } : {}) });
        const sessionReads: string[] = [];
        const batches: string[][] = [];
        let denied = false;
        let incomplete = false;
        let batchGate: ReturnType<typeof createDeferred<void>> | null = null;
        let batchStarted: ReturnType<typeof createDeferred<void>> | null = null;
        let records: import('@happier-dev/protocol/drafts/sessionDraftsV2').SessionDraftRecordV2[] = [];
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ features: {
                sessions: { drafts: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } },
            } }));
            if (path === '/v1/account/encryption/currentness') return Response.json(accountMode === 'plain'
                ? createPlainAccountEncryptionCurrentnessFixture() : { mode: 'e2ee', version: 1, signingKeyFingerprint: 'fixture-signing',
                    contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(
                        deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey), updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v2/account/settings') return Response.json({ content: accountMode === 'plain' ? { t: 'plain', v: {} } : null, version: 1 });
            if (path === '/v2/account/session-drafts/list') return Response.json({ items: records });
            if (path === '/v2/account/session-drafts/read') return Response.json({ status: 'absent' });
            if (path === '/v2/sessions/read-batch') {
                const request = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
                batches.push(request.sessionIds);
                batchStarted?.resolve();
                if (batchGate) await batchGate.promise;
                if (incomplete) return Response.json({ results: [] });
                return Response.json({ results: request.sessionIds.map(sessionId => ({ sessionId,
                    ...(denied && sessionId.endsWith('missing-a') ? {
                        detail: { status: 404, body: { error: 'Session not found' } },
                    } : {
                        detail: { status: 200, body: { session: row(sessionId) } },
                        ...(request.includeTurns === false ? {} : { turns: { status: 200, body: { v: 1, sessionId, updatedAt: 1, turns: [] } } }),
                    }),
                })) });
            }
            if (/^\/v2\/sessions\/draft-context-/.test(path)) {
                sessionReads.push(path);
                return Response.json({ session: row(path.split('/').at(-1)!) });
            }
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer(credentials);
        await flushHookEffects({ cycles: 12, turns: 2 });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected the real active draft Account');
        const cipher = createSessionDraftCipher({ accountMode, accountCryptoMaterial: accountMode === 'plain' ? null : { type: 'legacy', secret },
            getSessionContext: sessionId => accountMode === 'plain' ? { mode: 'plain' }
                : { mode: 'e2ee', encryption: authorEncryption.getSessionEncryption(sessionId) }, randomBytes: length => new Uint8Array(length) });
        const author = drafts.createSessionDraftRepository({ storage: { getString: () => undefined, set: () => {}, delete: () => {} },
            scope, cipher, syncEnabled: false });
        records = await Promise.all(['retained', 'missing-a', 'missing-b'].map(async suffix => {
            const sessionId = `draft-context-${suffix}`;
            author.writeExistingSessionDraft({ scope, sessionId, patch: { text: `kept ${suffix}` } });
            const snapshot = author.getSessionDraftSnapshot(scope, { kind: 'session', sessionId })!;
            return { address: snapshot.address, content: await cipher.seal(snapshot.address, snapshot.document), revision: 1, createdAt: 1, updatedAt: 1 };
        }));
        const { sync } = await import('./syncEngine');
        if (accountMode === 'e2ee') {
            if (!sync.encryption) throw new Error('Expected the real Account encryption owner');
            await sync.encryption.initializeSessions(new Map([['draft-context-retained', keys.get('draft-context-retained')!]]), { serverId: scope.serverId });
        }
        storage.getState().applySessions([createSessionFixture({ id: 'draft-context-retained', serverId: scope.serverId, encryptionMode: accountMode })]);
        sync.reconfigureSessionDraftRepositoryForAccountMode(credentials, accountMode);
        await drafts.ensureSessionDraftRepositoryHydrated(scope);
        expect(records.map(record => drafts.getExistingSessionDraftProjection(scope, record.address.kind === 'session' ? record.address.sessionId : '')?.text))
            .toEqual(['kept retained', 'kept missing-a', 'kept missing-b']);
        expect(sessionReads).toEqual([]);
        expect(batches).toEqual([['draft-context-missing-a', 'draft-context-missing-b']]);
        expect(storage.getState().sessions['draft-context-missing-a']).toBeUndefined();

        const advanceRecords = async (text: string) => {
            records = await Promise.all(records.map(async record => {
                if (record.address.kind !== 'session') throw new Error('Expected Session draft');
                author.writeExistingSessionDraft({ scope, sessionId: record.address.sessionId, patch: { text } });
                return { ...record, revision: record.revision + 1,
                    content: await cipher.seal(record.address, author.getSessionDraftSnapshot(scope, record.address)!.document) };
            }));
        };
        const text = (suffix: string) => drafts.getExistingSessionDraftProjection(scope, `draft-context-${suffix}`)?.text;
        denied = true;
        await advanceRecords('new remote text');
        await drafts.ensureSessionDraftRepositoryHydrated(scope);
        expect(text('missing-a')).toBe('kept missing-a');
        expect(text('missing-b')).toBe('new remote text');
        denied = false;
        await drafts.ensureSessionDraftRepositoryHydrated(scope);
        expect(text('missing-a')).toBe('new remote text');

        incomplete = true;
        await advanceRecords('after failed batch');
        await expect(drafts.ensureSessionDraftRepositoryHydrated(scope)).rejects.toThrow('Incomplete Session batch response');
        expect(text('retained')).toBe('new remote text');
        expect(text('missing-b')).toBe('new remote text');
        incomplete = false;
        await drafts.ensureSessionDraftRepositoryHydrated(scope);
        expect(text('missing-b')).toBe('after failed batch');

        // A plain Session never discloses an encrypted draft as a plain payload.
        const retainedRecord = records[0]!;
        records = [{ ...retainedRecord, revision: retainedRecord.revision + 1, content: accountMode === 'plain'
            ? { t: 'encrypted', c: 'wrong-mode' }
            : { t: 'plain', v: createSessionDraftPrivatePayloadV2(retainedRecord.address,
                author.getSessionDraftSnapshot(scope, retainedRecord.address)!.document) } }, ...records.slice(1)];
        await expect(drafts.ensureSessionDraftRepositoryHydrated(scope)).rejects.toThrow('Unable to open session draft');
        expect(text('retained')).toBe('after failed batch');
        records = [retainedRecord, ...records.slice(1)];

        await advanceRecords('must stay with retired scope');
        batchGate = createDeferred<void>();
        batchStarted = createDeferred<void>();
        const retiredRead = drafts.ensureSessionDraftRepositoryHydrated(scope);
        const retiredOutcome = retiredRead.catch(() => undefined);
        await batchStarted.promise;
        await disconnectActiveServerConnection();
        batchGate.resolve();
        await retiredOutcome;
        expect(text('missing-b')).toBe('after failed batch');
        expect(sessionReads).toEqual([]);
    });

});

