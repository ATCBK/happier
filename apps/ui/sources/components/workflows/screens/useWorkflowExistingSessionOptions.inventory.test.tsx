import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { SESSION_OWNER_METADATA_PROJECTION } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { SessionCurrentProjectionRecordV1Schema, SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

// Compile the real Sync graph outside individual case IO budgets, with its
// canonical SDK transport boundary installed before importing the singleton.
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

// Real layout-1 wire producers: the list leaves shared content unopened; detail
// admits it with the same Account material and per-Session envelope.
async function encryptedSessionFixture(id: string, accountId: string, progressBytes = 0, continuable = true) {
    const { Encryption } = await import('@/sync/encryption/encryption');
    const { encodeBase64 } = await import('@/encryption/base64');
    const secret = new Uint8Array(32).fill(9);
    const credentials = { token: createAccountTokenForTests(accountId),
        secret: encodeBase64(secret, 'base64url') };
    const encryption = await Encryption.create(secret);
    const key = new Uint8Array(32).fill(7);
    const cipher = await encryption.openEncryption(key);
    const plain = createPlainSessionCurrentProjectionRecordFixture({ id, active: true, metadata: {
        flavor: 'claude', ...(continuable ? { claudeSessionId: `resume-${id}`, claudeTranscriptPath: `/tmp/${id}.jsonl` } : {}),
        machineId: 'machine-a', path: '/repo', host: 'host-a', name: id,
    } });
    if (plain.ownerMetadata?.t !== 'plain') throw new Error('Expected canonical owner fixture');
    const [metadata] = await cipher.encrypt([JSON.parse(plain.metadata)]);
    const record = SessionCurrentProjectionRecordV1Schema.parse({ ...plain, encryptionMode: 'e2ee',
        metadata: encodeBase64(metadata!, 'base64'),
        dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key), 'base64'),
        ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
            ownerMetadata: { ...plain.ownerMetadata.v, ...(progressBytes ? { cursors: { externalSessionAttentionV1: {
                v: 1 as const, observedProgressToken: 'p'.repeat(progressBytes),
            } } } : {}) }, randomBytes: length => new Uint8Array(length).fill(3) }),
    });
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'e2ee', version: 1, updatedAt: 1,
        signingKeyFingerprint: 'synthetic-signing-key',
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint),
        recipientEnvelopeReadiness: { status: 'available' },
    });
    return { record, credentials, currentness, encryption, key };
}

let homes: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
    setServerReachabilityNetworkAllowed(true);
    standardCleanup();
    await homes?.dispose();
    homes = undefined;
    storage.setState(storage.getInitialState(), true);
});

it.each([1, 0] as const)('reuses already-admitted plain list continuation facts without duplicate snapshot reads; layout=%s', async layout => {
    const metadataFor = (index: number, continuable = true) => ({
        flavor: 'claude', ...(continuable ? { claudeSessionId: `resume-${index}`, claudeTranscriptPath: `/tmp/${index}.jsonl` } : {}),
        machineId: 'machine-a', path: '/repo', host: 'host-a', name: `Admitted ${index}`,
    });
    const records = Array.from({ length: 3 }, (_, index) => {
        const record = createPlainSessionCurrentProjectionRecordFixture({ id: `admitted-plain-${index}`, active: true, metadata: metadataFor(index) });
        if (layout === 0) {
            const legacy = { ...record, metadataLayoutVersion: 0, metadata: JSON.stringify(metadataFor(index)) };
            // Layout0 forbids the property itself, even when its value is undefined.
            Reflect.deleteProperty(legacy, 'ownerMetadata');
            return SessionCurrentProjectionRecordV1Schema.parse(legacy);
        }
        // Public display identity is not the owner's execution configuration.
        return SessionCurrentProjectionRecordV1Schema.parse({ ...record,
            metadata: JSON.stringify({ ...JSON.parse(record.metadata), agentPresentation: { agentId: 'codex' } }),
        });
    });
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = records.find(value => request.path === `/v2/sessions/${value.id}`);
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://chooser-admitted-plain.test', accountId: 'chooser-admitted-plain' }],
        route: request => {
            if (request.path === '/v2/sessions') return Response.json({
                sessions: request.accountId === 'chooser-admitted-plain' ? records : [], nextCursor: null, hasNext: false,
            });
            if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            return batch.handle(request);
        } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { ensureSessionMetadataInventoryForServerAccountScope } = await import('@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope');
    const hook = await renderHook(({ enabled }) => {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        return { ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }), binding };
    }, { initialProps: { enabled: false } });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
        const binding = hook.getCurrent().binding!;
        await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({ scope: binding.scope, accountLifetime: binding }); });
        expect(Object.keys(storage.getState().sessionListRowsByServerId[serverId] ?? {})).toHaveLength(records.length);
        expect(storage.getState().sessions).toEqual({});
        const readsBeforeOpen = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').length;
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions).toEqual(records.map((record, index) => ({
            sessionId: record.id, machineId: 'machine-a', label: `Admitted ${index}`,
        })));
        const readsAfterOpen = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').length;
        expect(readsAfterOpen - readsBeforeOpen).toBe(layout === 1 ? 0 : 1);
        if (layout === 0) expect(SessionReadBatchRequestV1Schema.parse(
            homes.requests.filter(request => request.path === '/v2/sessions/read-batch').at(-1)!.body,
        ).sessionIds).toEqual(records.map(record => record.id));
        // List reuse is not full-snapshot authority: a selected Session still
        // passes the exact current authenticated read when the next step needs it.
        const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
        const { readSessionSnapshotsForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
        const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
        const { serverFetch } = await import('@/sync/http/client');
        await act(async () => { await runWithServerRequestAuthorityForServerAccountScope({ scope: binding.scope, activeRequest: serverFetch }, async authority => {
            const selected = (await readSessionSnapshotsForAuthority({ authority, sessionIds: [records[0]!.id], includeTurns: false })).get(records[0]!.id);
            if (!selected?.ok) throw new Error('Expected the selected Session to pass full snapshot admission');
            expect(readSessionOwnerMetadataView(selected.snapshot.session)).toMatchObject({ flavor: 'claude', claudeSessionId: 'resume-0' });
        }); });
        const selectedReads = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').slice(readsAfterOpen);
        expect(selectedReads).toHaveLength(1);
        expect(SessionReadBatchRequestV1Schema.parse(selectedReads[0]!.body).sessionIds).toEqual([records[0]!.id]);
        if (layout === 1) {
            const originalSettings = storage.getState().settings;
            await act(async () => { storage.setState({ settings: { ...originalSettings,
                backendEnabledByTargetKey: { ...originalSettings.backendEnabledByTargetKey,
                    'agent:happier.agent.codex/codex': false },
            } }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
            expect(hook.getCurrent().existingSessions).toHaveLength(records.length);
            await act(async () => { storage.setState({ settings: { ...originalSettings,
                backendEnabledByTargetKey: { ...originalSettings.backendEnabledByTargetKey,
                    'agent:happier.agent.claude/claude': false },
            } }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
            expect(hook.getCurrent().existingSessions).toEqual([]);
            await act(async () => { storage.setState({ settings: originalSettings }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
            expect(hook.getCurrent().existingSessions).toHaveLength(records.length);
            // Re-admit changed private continuation facts through the real list
            // producer. Display identity/title stay equal; eligibility must not.
            records[0] = { ...createPlainSessionCurrentProjectionRecordFixture({ id: records[0]!.id, active: true,
                metadataVersion: records[0]!.metadataVersion + 1, metadata: metadataFor(0, false) }), metadata: records[0]!.metadata };
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const credentials = (await TokenStorage.getCredentialsForServerUrl(homes.homes.a!.serverUrl))!;
            const { fetchAndApplySessions } = await import('@/sync/engine/sessions/sessionSnapshot');
            await act(async () => { await fetchAndApplySessions({ serverId, credentials, encryption: null, sessionDataKeys: new Map(),
                request: (path, init) => homes!.fetch(new URL(path, homes!.homes.a!.serverUrl), init),
                getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
                applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
                applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
                applySessions: () => {}, awaitSessionListHydration: true, log: { log() {} },
            }); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
            expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual(records.slice(1).map(record => record.id));
            expect(homes.requests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(readsAfterOpen + 1);
            // Reused options must leave with their credential/Account lifetime,
            // even with no outstanding detail request to abort.
            await act(async () => { await homes!.switchAccount('a', 'replacement-plain-account'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions).toEqual([]));
        }
    } finally { await hook.unmount(); }
});

it('retains unopened owner provenance only when the list producer receives its previous row', async () => {
    const { record, credentials, currentness } = await encryptedSessionFixture('diag183-projection', 'diag183-projection');
    const { buildRenderableFromRowAndCache } = await import('@/sync/engine/sessions/sessionSnapshot');
    const { readSessionListRenderableOwnerMetadataView } = await import('@/sync/domains/session/listing/sessionListRenderableSessionProjection');
    const first = buildRenderableFromRowAndCache(record, credentials, currentness, undefined);
    const retained = buildRenderableFromRowAndCache(record, credentials, currentness, undefined, undefined, first);
    // Mis-wire the exact same producer by omitting the previous-row input,
    // matching the fresh-map inventory getter. No internal owner is mocked.
    const miswired = buildRenderableFromRowAndCache(record, credentials, currentness, undefined);
    expect(first[SESSION_OWNER_METADATA_PROJECTION]).toBeTruthy();
    expect(retained[SESSION_OWNER_METADATA_PROJECTION]).toBe(first[SESSION_OWNER_METADATA_PROJECTION]);
    expect(miswired[SESSION_OWNER_METADATA_PROJECTION]).not.toBe(first[SESSION_OWNER_METADATA_PROJECTION]);
    for (const row of [first, retained, miswired]) {
        // Reusing provenance cannot admit still-unopened Session content.
        expect(readSessionListRenderableOwnerMetadataView(row, { requireAdmitted: {
            credentials, accountCurrentness: currentness, isCurrent: () => true,
        } })).toBeNull();
    }
    const changed = await encryptedSessionFixture(record.id, 'diag183-projection', 0, false);
    const changedEnvelope = buildRenderableFromRowAndCache({ ...record, ownerMetadata: changed.record.ownerMetadata },
        credentials, currentness, undefined, undefined, first);
    expect(changedEnvelope[SESSION_OWNER_METADATA_PROJECTION]).not.toBe(first[SESSION_OWNER_METADATA_PROJECTION]);
});

it('retains unopened owner provenance when exact Account credentials are recaptured without changing material', async () => {
    const { record, credentials, currentness } = await encryptedSessionFixture('diag183-recaptured', 'diag183-recaptured');
    const { buildRenderableFromRowAndCache } = await import('@/sync/engine/sessions/sessionSnapshot');
    const first = buildRenderableFromRowAndCache(record, credentials, currentness, undefined);
    const recaptured = { ...credentials };
    expect(recaptured).not.toBe(credentials);
    expect(first[SESSION_OWNER_METADATA_PROJECTION]?.isCurrentAuthority?.({ credentials: recaptured,
        accountCurrentness: currentness })).toBe(true);
    const retained = buildRenderableFromRowAndCache(record, recaptured, currentness, undefined, undefined, first);
    expect(retained[SESSION_OWNER_METADATA_PROJECTION]).toBe(first[SESSION_OWNER_METADATA_PROJECTION]);
});

// DIAG183: identical inventory refreshes must not retire an in-flight borrower.
it.each([
    { missing: false, refreshes: 0 },
    { missing: true, refreshes: 0 },
    { missing: false, refreshes: 3 },
    { missing: true, refreshes: 3 },
])('settles unopened ineligible Sessions across identical inventory publications; missing=$missing refreshes=$refreshes', async ({ missing, refreshes }) => {
    const accountId = `diag183-empty-${missing}-${refreshes}`;
    const first = await encryptedSessionFixture('diag183-a', accountId, 0, false);
    const second = await encryptedSessionFixture('diag183-b', accountId, 0, false);
    const third = await encryptedSessionFixture('diag183-c', accountId, 0, false);
    const records = [first.record, second.record, third.record];
    const detail = createDeferred<void>();
    let successfulBatchResponses = 0;
    const batches: AbortSignal[] = [];
    const batch = createSessionReadBatchHttpBoundary(async request => {
        if (request.path === '/v2/sessions/read-batch') {
            batches.push(request.signal!);
            return undefined;
        }
        const record = records.find(value => request.path === `/v2/sessions/${value.id}`);
        if (!record) return undefined;
        await detail.promise;
        return missing ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json({ session: record });
    });
    homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: `https://${accountId}.test`, accountId,
        accountMode: 'e2ee', credentials: first.credentials, encryptionCurrentness: () => first.currentness }], route: async request => {
        if (request.path === '/v2/sessions') return Response.json({ sessions: records, nextCursor: null, hasNext: false });
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        const response = await batch.handle(request);
        if (request.path === '/v2/sessions/read-batch' && response?.status === 200) successfulBatchResponses += 1;
        return response;
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { ensureSessionMetadataInventoryForServerAccountScope } = await import('@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope');
    const hook = await renderHook(({ enabled }) => {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        return { ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }), binding };
    }, { initialProps: { enabled: false } });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
        const binding = hook.getCurrent().binding!;
        await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({ scope: binding.scope, accountLifetime: binding }); });
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(batches).toHaveLength(1));
        for (let refresh = 0; refresh < refreshes; refresh += 1) {
            const before = storage.getState().sessionListRowsByServerId[serverId]![first.record.id]!;
            await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({
                scope: binding.scope, accountLifetime: binding, refresh: true,
            }); });
            const after = storage.getState().sessionListRowsByServerId[serverId]![first.record.id]!;
            expect(after[SESSION_OWNER_METADATA_PROJECTION]).toBe(before[SESSION_OWNER_METADATA_PROJECTION]);
            expect(after).toBe(before);
            expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
            expect(hook.getCurrent().existingSessions).toEqual([]);
        }
        expect(batches).toHaveLength(1);
        expect(batches[0]!.aborted).toBe(false);
        await act(async () => { detail.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe(missing ? 'error' : 'ready'));
        expect(hook.getCurrent().existingSessions).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
        expect(batches).toHaveLength(1);
        expect(successfulBatchResponses).toBe(1);
        if (refreshes === 3 && !missing) {
            const before = storage.getState().sessionListRowsByServerId[serverId]![first.record.id]!;
            const changed = await encryptedSessionFixture(first.record.id, accountId, 0, true);
            // Only the private envelope changes: public display/versions stay equal.
            records[0] = { ...first.record, ownerMetadata: changed.record.ownerMetadata };
            await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({
                scope: binding.scope, accountLifetime: binding, refresh: true,
            }); });
            const after = storage.getState().sessionListRowsByServerId[serverId]![first.record.id]!;
            expect(after[SESSION_OWNER_METADATA_PROJECTION]).not.toBe(before[SESSION_OWNER_METADATA_PROJECTION]);
            await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
            expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([first.record.id]);
            records.shift();
            await act(async () => { await ensureSessionMetadataInventoryForServerAccountScope({
                scope: binding.scope, accountLifetime: binding, refresh: true,
            }); });
            expect(storage.getState().sessionListRowsByServerId[serverId]?.[first.record.id]).toBeUndefined();
            await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions).toEqual([]));
        }
    } finally { detail.resolve(); await hook.unmount(); }
});

it('batch-reads only never-admitted encrypted rows alongside admitted list rows', async () => {
    const accountId = 'chooser-mixed-encrypted';
    const first = await encryptedSessionFixture('admitted-encrypted-a', accountId);
    const second = await encryptedSessionFixture('admitted-encrypted-b', accountId);
    const unopened = await encryptedSessionFixture('never-admitted-encrypted', accountId);
    const records = [first.record, second.record, unopened.record];
    const page = { sessions: records, nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false };
    const queryPage = SessionListQueryResponseV1Schema.parse({ ...page,
        sessions: records.map(record => ({ ...record, viewer: createSessionViewerFixture() })),
    });
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = records.find(value => request.path === `/v2/sessions/${value.id}`);
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://chooser-mixed-encrypted.test', accountId,
        accountMode: 'e2ee', credentials: first.credentials, encryptionCurrentness: () => first.currentness }], route: request => {
        if (request.path === '/v2/sessions') return Response.json(page);
        if (request.path === '/v2/sessions/query') return Response.json(queryPage);
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { ensureSessionMetadataInventoryForServerAccountScope } = await import('@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope');
    const { fetchAndApplySessions } = await import('@/sync/engine/sessions/sessionSnapshot');
    const hook = await renderHook(({ enabled }) => {
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        return { ...useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }), binding };
    }, { initialProps: { enabled: false } });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().binding).toBeTruthy());
        const binding = hook.getCurrent().binding!;
        await act(async () => {
            await ensureSessionMetadataInventoryForServerAccountScope({ scope: binding.scope, accountLifetime: binding });
            await fetchAndApplySessions({ serverId, credentials: first.credentials, accountCurrentness: first.currentness,
                encryption: first.encryption, sessionDataKeys: new Map(),
                source: { kind: 'query', body: { v: 1, storage: 'active', includeInactive: true,
                    scope: 'my_work', attention: 'any', audiences: [], tagIds: [] }, allowV1Fallback: false },
                requiredHydrationSessionIds: [first.record.id, second.record.id], awaitSessionListHydration: true,
                sessionListMaxPages: 1, sessionListEagerHydrationCount: 0, sessionListBackgroundHydrationMaxRows: 0,
                request: (path, init) => homes!.fetch(new URL(path, homes!.homes.a!.serverUrl), init),
                getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[serverId]?.[id],
                applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
                applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
                applySessions: () => {}, log: { log() {} },
            });
        });
        const rows = storage.getState().sessionListRowsByServerId[serverId]!;
        expect(rows[first.record.id]?.metadata?.machineId).toBe('machine-a');
        expect(rows[second.record.id]?.metadata?.machineId).toBe('machine-a');
        expect(rows[unopened.record.id]?.metadata?.machineId).toBeNull();
        expect(storage.getState().sessions).toEqual({});
        const readsBeforeOpen = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').length;
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions.map(option => option.sessionId).sort()).toEqual(records.map(record => record.id).sort());
        const reads = homes.requests.filter(request => request.path === '/v2/sessions/read-batch').slice(readsBeforeOpen);
        expect(reads).toHaveLength(1);
        expect(SessionReadBatchRequestV1Schema.parse(reads[0]!.body).sessionIds).toEqual([unopened.record.id]);
    } finally { await hook.unmount(); }
});

it.skipIf(process.env.HAPPIER_DIAG181_BENCHMARK !== '1')('profiles 1000 encrypted snapshots at the admitted batch owner', async () => {
    // Match R101's order of magnitude (20 MB / ~1000 snapshots), with real
    // canonical encrypted owner cursors and separately sealed Session DEKs.
    const { record, credentials, currentness, encryption, key } = await encryptedSessionFixture('diag181-encrypted', 'diag181-benchmark', 14000);
    const { encodeBase64 } = await import('@/encryption/base64');
    const records = await Promise.all(Array.from({ length: 1000 }, async (_, index) => ({ ...record, id: `diag181-${index}`,
        dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key), 'base64') })));
    let responseAt = 0;
    let responseBytes = 0;
    homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://diag181-benchmark.test',
        accountId: 'diag181-benchmark', accountMode: 'e2ee', credentials, encryptionCurrentness: () => currentness }], route: request => {
        if (request.path !== '/v2/sessions/read-batch') return undefined;
        const demand = SessionReadBatchRequestV1Schema.parse(request.body);
        const byId = new Map(records.map(value => [value.id, value]));
        const serialized = JSON.stringify({ results: demand.sessionIds.map(sessionId => ({ sessionId,
            detail: { status: 200, body: { session: byId.get(sessionId) } } })) });
        responseBytes = new TextEncoder().encode(serialized).length;
        const response = new Response(serialized, { headers: { 'content-type': 'application/json' } });
        responseAt = performance.now();
        return response;
    } });
    const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
    const { readSessionSnapshotsForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
    const { serverFetch } = await import('@/sync/http/client');
    const { Session } = await import('node:inspector');
    const { writeFile } = await import('node:fs/promises');
    const profiler = new Session();
    profiler.connect();
    const post = <T,>(method: string) => new Promise<T>((resolve, reject) => profiler.post(method, (error, result) => error ? reject(error) : resolve(result as T)));
    const started = performance.now();
    let firstAt = 0;
    let published = 0;
    await post('Profiler.enable');
    await post('Profiler.start');
    try {
        await runWithServerRequestAuthorityForServerAccountScope({ scope: { serverId: homes.homes.a!.id, accountId: 'diag181-benchmark' }, activeRequest: serverFetch }, async authority => {
            const results = await readSessionSnapshotsForAuthority({ authority, sessionIds: records.map(value => value.id), includeTurns: false,
                onResult: (_id, result) => { expect(result.ok).toBe(true); firstAt ||= performance.now(); published += 1; } });
            expect(results.size).toBe(records.length);
            expect([...results.values()].every(result => result.ok)).toBe(true);
        });
    } finally {
        const { profile } = await post<{ profile: unknown }>('Profiler.stop');
        await writeFile(process.env.HAPPIER_DIAG181_PROFILE ?? '/tmp/diag181-benchmark.cpuprofile', JSON.stringify(profile));
        profiler.disconnect();
    }
});

it.each([false, true])('offers the first settled unopened batch while a later batch is held, retaining successes on failure=%s', async failLater => {
    const accountId = `picker-progress-${failLater}`;
    const { record: first, credentials, currentness } = await encryptedSessionFixture('progress-first', accountId);
    const { record: later } = await encryptedSessionFixture('progress-later', accountId);
    const firstRead = createDeferred<void>();
    const laterRead = createDeferred<void>();
    const batch = createSessionReadBatchHttpBoundary(async request => {
        if (request.path === `/v2/sessions/${first.id}`) {
            await firstRead.promise;
            return Response.json({ session: first });
        }
        if (request.path === `/v2/sessions/${later.id}`) {
            await laterRead.promise;
            return failLater ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json({ session: later });
        }
        return undefined;
    });
    homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: `https://${accountId}.test`, accountId,
        accountMode: 'e2ee', credentials, encryptionCurrentness: () => currentness }], route: request => {
        if (request.path === '/v2/sessions') return Response.json({ sessions: [first, later], nextCursor: null, hasNext: false });
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
    const { readSessionSnapshotsForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
    const { serverFetch } = await import('@/sync/http/client');
    const hook = await renderHook(({ enabled }) => useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        { initialProps: { enabled: false } });
    // A genuine earlier borrower selects the first physical batch. The chooser
    // joins it and selects only the remaining id into a second physical batch;
    // no fake body budget, internal reader mock or production batch-size knob.
    const incumbent = runWithServerRequestAuthorityForServerAccountScope({ scope: { serverId, accountId }, activeRequest: serverFetch },
        authority => readSessionSnapshotsForAuthority({ authority, sessionIds: [first.id], includeTurns: false }));
    const batchRequests = () => homes!.requests.filter(request => request.path === '/v2/sessions/read-batch');
    try {
        await waitForHomeGovernance(() => expect(batchRequests()).toHaveLength(1));
        const started = performance.now();
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(batchRequests()).toHaveLength(2));
        expect(hook.getCurrent().existingSessions).toEqual([]);
        expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
        await act(async () => { firstRead.resolve(); });
        await vi.waitFor(() => expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([first.id]));
        const firstOfferedMs = performance.now() - started;
        expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
        expect(storage.getState().sessions[first.id]).toBeUndefined();
        expect(batchRequests().every(request => SessionReadBatchRequestV1Schema.parse(request.body).includeTurns === false)).toBe(true);
        await act(async () => { laterRead.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe(failLater ? 'error' : 'ready'));
        expect(hook.getCurrent().existingSessions.map(option => option.sessionId).sort()).toEqual(failLater ? [first.id] : [first.id, later.id]);
    } finally {
        firstRead.resolve(); laterRead.resolve();
        await incumbent;
        await hook.unmount();
    }
});

it('offers all 1090 already-admitted candidates without a duplicate detail batch', async () => {
    // The observed fin2 candidate count is a workload, not a production limit.
    // Plain fixtures isolate acquisition/publication cost from native E2EE work.
    const records = Array.from({ length: 1090 }, (_, index) => {
        const id = `cold-${index}`;
        return createPlainSessionCurrentProjectionRecordFixture({ id, active: true, metadata: {
            flavor: 'claude', claudeSessionId: `resume-${id}`, claudeTranscriptPath: `/tmp/${id}.jsonl`,
            machineId: 'machine-a', path: '/repo', host: 'host-a', name: id,
        } });
    });
    const byId = new Map(records.map(record => [record.id, record]));
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = byId.get(request.path.slice('/v2/sessions/'.length));
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://picker-cold-heavy.test', accountId: 'picker-cold-heavy' }],
        route: request => {
            if (request.path === '/v2/sessions') return Response.json({ sessions: records, nextCursor: null, hasNext: false });
            if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            return batch.handle(request);
        } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const started = performance.now();
    let firstOfferedMs: number | undefined;
    let completedMs: number | undefined;
    let renders = 0;
    const hook = await renderHook(() => {
        const options = useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a' });
        renders += 1;
        if (firstOfferedMs === undefined && options.existingSessions.length > 0) firstOfferedMs = performance.now() - started;
        if (completedMs === undefined && options.sessionOptionsStatus === 'ready' && options.existingSessions.length === records.length) {
            completedMs = performance.now() - started;
        }
        return options;
    });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions).toHaveLength(records.length);
        expect(Object.keys(storage.getState().sessions)).toEqual([]);
        const requests = homes.requests.filter(request => request.path === '/v2/sessions/read-batch');
        expect(requests).toHaveLength(0);
    } finally { await hook.unmount(); }
});

it('offers an unopened layout-1 Session from its admitted owner view without hydrating it or requesting turns', async () => {
    const { record: c, credentials, currentness } = await encryptedSessionFixture('layout-1-c', 'picker-owner');
    const batch = createSessionReadBatchHttpBoundary(request => request.path === `/v2/sessions/${c.id}`
        ? Response.json({ session: c }) : undefined);
    homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://workflow-picker-owner.test',
        accountId: 'picker-owner', accountMode: 'e2ee', credentials, encryptionCurrentness: () => currentness }], route: request => {
        if (request.path === '/v2/sessions') return Response.json({ sessions: [c], nextCursor: null, hasNext: false });
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const started = performance.now();
    let firstOfferedMs: number | undefined;
    const hook = await renderHook(() => {
        const options = useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a' });
        if (firstOfferedMs === undefined && options.existingSessions.some(option => option.sessionId === c.id)) {
            firstOfferedMs = performance.now() - started;
        }
        return options;
    });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
    // The genuine cold list projection carries visibility but no Machine identity.
    expect(storage.getState().sessionListRowsByServerId[serverId]?.[c.id]).toMatchObject({ metadata: { machineId: null }, metadataLayoutVersion: 1 });
    expect(hook.getCurrent().existingSessions).toEqual([{ sessionId: c.id, machineId: 'machine-a', label: c.id }]);
    expect(storage.getState().sessions[c.id]).toBeUndefined();
    // Deliberately wire the same real admitted snapshot to the resolver with
    // each metadata view. The shared-view mis-wire loses attribution, while
    // the hook above must offer C using its owner view.
    const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
    const { readSessionSnapshotsForAuthority } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
    const { resolveDisplayMachineIdForSessionFromState } = await import('@/sync/domains/session/resolveMachineTargetForSessionFromState');
    const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
    const { serverFetch } = await import('@/sync/http/client');
    await runWithServerRequestAuthorityForServerAccountScope({ scope: { serverId, accountId: 'picker-owner' }, activeRequest: serverFetch }, async authority => {
        const result = (await readSessionSnapshotsForAuthority({ authority, sessionIds: [c.id], includeTurns: false })).get(c.id);
        if (!result?.ok) throw new Error('Expected the admitted layout-1 snapshot');
        const session = result.snapshot.session;
        const target = { state: storage.getState(), serverId, sessionId: c.id };
        expect(resolveDisplayMachineIdForSessionFromState({ ...target, metadata: session.metadata })).toBe('');
        expect(resolveDisplayMachineIdForSessionFromState({ ...target, metadata: readSessionOwnerMetadataView(session) })).toBe('machine-a');
    });
    const requests = homes.requests.filter(request => request.path === '/v2/sessions/read-batch');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(request => SessionReadBatchRequestV1Schema.parse(request.body).includeTurns === false)).toBe(true);
    await hook.unmount();
});

it('waits for paged inventory across bootstrap publications, then refreshes material changes and fences Account retirement', async () => {
    const { record: c, credentials, currentness } = await encryptedSessionFixture('bootstrap-c', 'picker-bootstrap');
    const { record: a } = await encryptedSessionFixture('bootstrap-a', 'picker-bootstrap');
    const inventoryPage = createDeferred<void>();
    let detailedRead = createDeferred<void>();
    let demanded = false;
    let failing = false;
    let holdDetail = true;
    const batches: AbortSignal[] = [];
    const batch = createSessionReadBatchHttpBoundary(async request => {
        if (request.path === '/v2/sessions/read-batch') {
            if (demanded) batches.push(request.signal!);
            return undefined;
        }
        if (request.path === `/v2/sessions/${c.id}` || request.path === `/v2/sessions/${a.id}`) {
            if (holdDetail) await detailedRead.promise;
            return failing ? Response.json({ error: 'not_found' }, { status: 404 })
                : Response.json({ session: request.path.endsWith(c.id) ? c : a });
        }
        return undefined;
    });
    homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://workflow-picker-bootstrap.test',
        accountId: 'picker-bootstrap', accountMode: 'e2ee', credentials, encryptionCurrentness: () => currentness }], route: async request => {
        if (request.path === '/v2/sessions') {
            if (!demanded || request.accountId !== 'picker-bootstrap') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (!request.url.searchParams.has('cursor')) return Response.json({ sessions: [a], nextCursor: 'next', hasNext: true });
            await inventoryPage.promise;
            return Response.json({ sessions: [c], nextCursor: null, hasNext: false });
        }
        if (request.path === '/v2/sessions/active' || request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { fetchAndApplySessions } = await import('@/sync/engine/sessions/sessionSnapshot');
    const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
    const auth = (await TokenStorage.getCredentialsForServerUrl(homes.homes.a!.serverUrl))!;
    const encryption = await createEncryptionFromAuthCredentials(auth);
    const hook = await renderHook(({ enabled }) => useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        { initialProps: { enabled: false } });
    await act(async () => { expect((await resolveServerCredentialAccountScope(serverId)).kind).toBe('bound'); });
    demanded = true;
    await hook.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(homes!.requests.some(request => request.url.searchParams.get('cursor') === 'next')).toBe(true));
    // Normal bootstrap page producer and real scoped store; no internal row fabrication.
    const publishBootstrap = async (records: typeof c[]) => {
        await act(async () => { await fetchAndApplySessions({ serverId, credentials: auth, encryption,
            sessionDataKeys: new Map(), sessionListMaxPages: 1,
            request: async (path, init) => path.startsWith('/v2/sessions')
                ? Response.json({ sessions: records, nextCursor: null, hasNext: false })
                : homes!.fetch(new URL(path, homes!.homes.a!.serverUrl), init),
            applySessions: () => {},
            applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
            log: { log: () => {} },
        }); });
    };
    try {
        await publishBootstrap([a]);
        await publishBootstrap([a, c]);
        expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
        expect(batches).toHaveLength(0);
        await act(async () => { inventoryPage.resolve(); });
        await waitForHomeGovernance(() => expect(batches).toHaveLength(1));
        expect(batches[0]!.aborted).toBe(false);
        expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
        holdDetail = false;
        await act(async () => { detailedRead.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions.map(option => option.sessionId).sort()).toEqual([a.id, c.id]);
        expect(storage.getState().sessions[c.id]).toBeUndefined();
        failing = true;
        await act(async () => { storage.getState().applyServerScopedSessionListRowPatches(serverId, [
            { sessionId: c.id, patch: { metadataVersion: c.metadataVersion + 1 } },
        ]); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('error'));
        failing = false;
        await act(async () => { hook.getCurrent().retrySessionOptions(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('ready'));
        expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toContain(c.id);
        await act(async () => { storage.getState().clearSessionListRowsForServerScope(serverId); });
        expect(hook.getCurrent().existingSessions).toEqual([]);
        await publishBootstrap([c]);
        await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([c.id]));
        detailedRead = createDeferred<void>();
        holdDetail = true;
        const beforeRetirement = batches.length;
        await act(async () => { storage.getState().applyServerScopedSessionListRowPatches(serverId, [
            { sessionId: c.id, patch: { metadataVersion: c.metadataVersion + 2 } },
        ]); });
        await waitForHomeGovernance(() => expect(batches.length).toBeGreaterThan(beforeRetirement));
        const retiringRead = batches.at(-1)!;
        await act(async () => { await homes!.switchAccount('a', 'replacement-account'); });
        expect(retiringRead.aborted).toBe(true);
        await act(async () => { detailedRead.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions).toEqual([]));
        expect(storage.getState().sessions[c.id]).toBeUndefined();
    } finally {
        inventoryPage.resolve(); detailedRead.resolve();
        await hook.unmount();
    }
});

it('lists paged unopened Sessions without reading hidden/archived snapshots or offering ineligible and other-Home Sessions', async () => {
    const metadata = { flavor: 'claude', claudeSessionId: 'resume-c', claudeTranscriptPath: '/tmp/c.jsonl',
        machineId: 'machine-a', path: '/repo', host: 'host-a', name: 'Session C' };
    const c = createPlainSessionCurrentProjectionRecordFixture({ id: 'unopened-c', active: true, metadata });
    const hidden = createPlainSessionCurrentProjectionRecordFixture({ id: 'hidden', active: true, metadata: {
        ...metadata, systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
    } });
    const otherMachine = createPlainSessionCurrentProjectionRecordFixture({ id: 'other-machine', active: true,
        metadata: { ...metadata, machineId: 'machine-b' } });
    const archived = Array.from({ length: 300 }, (_, index) => createPlainSessionCurrentProjectionRecordFixture({
        id: `archived-${index}`, active: false, archivedAt: 42, metadata,
    }));
    const ineligible = createPlainSessionCurrentProjectionRecordFixture({ id: 'ineligible', active: true,
        metadata: { flavor: 'claude', machineId: 'machine-a', path: '/repo', host: 'host-a' } });
    let deleted = false;
    const batch = createSessionReadBatchHttpBoundary(request => {
        const record = [c, hidden, otherMachine, ineligible, ...archived].find(row => request.path === `/v2/sessions/${row.id}`);
        return record ? Response.json({ session: record }) : undefined;
    });
    homes = await serveAccountHomes({ homes: [
        { key: 'a', serverUrl: 'https://workflow-picker-a.test', accountId: 'picker-account-a' },
        { key: 'b', serverUrl: 'https://workflow-picker-b.test', accountId: 'picker-account-b' },
    ], route: request => {
        if (request.path === '/v2/sessions/archived') {
            return Response.json({ sessions: archived, nextCursor: null, hasNext: false });
        }
        if (request.path === '/v2/sessions/active') {
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        }
        if (request.path === '/v2/sessions') {
            if (request.home === 'b') return Response.json({ sessions: [
                createPlainSessionCurrentProjectionRecordFixture({ id: 'other-home-only', active: true,
                    metadata: { ...metadata, name: 'Other Home' } }),
            ], nextCursor: null, hasNext: false });
            return Response.json(deleted ? { sessions: [], nextCursor: null, hasNext: false }
                : request.url.searchParams.get('cursor')
                    ? { sessions: [c, otherMachine, ineligible], nextCursor: null, hasNext: false }
                    : { sessions: [hidden], nextCursor: 'page-2', hasNext: true });
        }
        return batch.handle(request);
    } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const hook = await renderHook(({ enabled }) => useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled }),
        { initialProps: { enabled: false } });
    expect(hook.getCurrent().existingSessions).toEqual([]);
    expect(homes.requests.some(request => request.home === 'a' && request.path === '/v2/sessions')).toBe(false);
    await hook.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.some(option => option.sessionId === c.id)).toBe(true));
    // Check cost before the full option list so an archived-row regression
    // reports the unnecessary reads rather than polling for a list it cannot produce.
    expect(batch.componentRequests.filter(request => request.path === `/v2/sessions/${hidden.id}`
        || archived.some(row => request.path === `/v2/sessions/${row.id}`))).toHaveLength(0);
    expect(hook.getCurrent().existingSessions).toEqual([
        { sessionId: c.id, machineId: 'machine-a', label: 'Session C' },
    ]);
    expect(storage.getState().sessions[c.id]).toBeUndefined();
    expect(hook.getCurrent().sessionOptionsStatus).toBe('ready');
    expect(hook.getCurrent().sessionDropCandidates.map(option => option.sessionId).sort()).toEqual(['other-machine', c.id]);
    expect(homes.requests.some(request => request.path === '/v2/sessions/read-batch' && request.home === 'a')).toBe(false);
    expect(homes.requests.some(request => request.path === '/v2/sessions' && request.url.searchParams.get('cursor') === 'page-2')).toBe(true);
    // Archival is a list lifecycle fact: an already displayed unopened Session
    // must disappear even though neither metadata nor its version changed.
    await act(async () => { storage.getState().applyServerScopedSessionListRowPatches(serverId, [
        { sessionId: otherMachine.id, patch: { archivedAt: 42 } },
    ]); });
    expect(hook.getCurrent().sessionDropCandidates.map(option => option.sessionId)).toEqual([c.id]);
    expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([c.id]);
    deleted = true;
    await act(async () => { storage.getState().clearSessionListRowsForServerScope(serverId); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions).toEqual([]));
    await hook.unmount();
});

it.each([false, true])('starts each demanded acquisition as loading and retries a failed one through the same owner; cancel waiting=%s', async cancelWaiting => {
    const metadata = { flavor: 'claude', claudeSessionId: 'resume-r', claudeTranscriptPath: '/tmp/r.jsonl',
        machineId: 'machine-a', path: '/repo', host: 'host-a', name: 'Recovered' };
    const recovered = createPlainSessionCurrentProjectionRecordFixture({ id: 'recovered', active: true, metadata });
    let failing = true;
    const batch = createSessionReadBatchHttpBoundary(request => request.path === `/v2/sessions/${recovered.id}`
        ? Response.json({ session: recovered }) : undefined);
    homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://workflow-picker-retry.test', accountId: 'picker-retry' }],
        route: request => {
            if (request.path === '/v2/sessions') return Response.json({ sessions: [recovered], nextCursor: null, hasNext: false });
            // The detailed inventory's own archived page fails; the Home and its sync stay healthy.
            if (request.path === '/v2/sessions/archived') {
                return failing ? new Response('unavailable', { status: 503 })
                    : Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            if (request.path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            return batch.handle(request);
        } });
    const serverId = homes.homes.a!.id;
    storage.setState({ isDataReady: true, sessions: {}, sessionListRowsByServerId: {} });
    const { useWorkflowExistingSessionOptions } = await import('./useWorkflowExistingSessionOptions');
    const statuses: string[] = [];
    const hook = await renderHook(({ enabled }) => {
        const options = useWorkflowExistingSessionOptions({ serverId, machineId: 'machine-a', enabled });
        statuses.push(options.sessionOptionsStatus);
        return options;
    }, { initialProps: { enabled: false } });
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    await act(async () => { expect((await resolveServerCredentialAccountScope(serverId)).kind).toBe('bound'); });
    await hook.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('error'));
    // A failed read is not an empty Account, and a new demand never starts from the last one's outcome.
    await hook.rerender({ enabled: false });
    expect(hook.getCurrent().sessionOptionsStatus).toBe('ready');
    statuses.length = 0;
    await hook.rerender({ enabled: true });
    expect(statuses[0]).toBe('loading');
    await waitForHomeGovernance(() => expect(hook.getCurrent().sessionOptionsStatus).toBe('error'));
    failing = false;
    statuses.length = 0;
    setServerReachabilityNetworkAllowed(false);
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: homes.homes.a!.serverUrl, generation: 0 });
    storage.getState().setEndpointConnectivity({ status: 'offline', reason: null, attempt: 0, nextRetryAt: null,
        lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null });
    const requestsBeforeRetry = homes.requests.length;
    await act(async () => { hook.getCurrent().retrySessionOptions(); });
    await flushHookEffects();
    expect(statuses).toContain('loading');
    expect(hook.getCurrent().sessionOptionsStatus).toBe('loading');
    expect(homes.requests).toHaveLength(requestsBeforeRetry);
    if (cancelWaiting) {
        await hook.rerender({ enabled: false });
        expect(hook.getCurrent().sessionOptionsStatus).toBe('ready');
    }
    storage.getState().resetEndpointConnectivity();
    setServerReachabilityNetworkAllowed(true);
    if (cancelWaiting) {
        await flushHookEffects();
        expect(homes.requests.filter(request => request.path === '/v2/sessions' || request.path === '/v2/sessions/read-batch'))
            .toHaveLength(homes.requests.slice(0, requestsBeforeRetry).filter(request => request.path === '/v2/sessions' || request.path === '/v2/sessions/read-batch').length);
        await hook.rerender({ enabled: true });
    }
    await waitForHomeGovernance(() => expect(hook.getCurrent().existingSessions.map(option => option.sessionId)).toEqual([recovered.id]));
    expect(hook.getCurrent().sessionOptionsStatus).toBe('ready');
    await hook.unmount();
});
