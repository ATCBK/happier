import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createPlainSessionCurrentProjectionRecordFixture, requireComposerDraftDocument } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createReducer } from '@happier-dev/session-core/reducer';
import { MessageMetaSchema, type UserTextMessage } from '@happier-dev/session-core/messages';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests, subscribeSessionDraft } =
    await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { getSessionDraftPersistenceStorage, prepareSessionDraftPersistenceStorage } =
    await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
const { CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR } = await import('@/sync/runtime/sessionMessageDeliveryErrors');
const { completeSessionForkNavigation } = await import('./completeSessionForkNavigation');

describe('completeSessionForkNavigation', () => {
    let serverId: string;
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let accountId: string;
    let accountNumber = 0;
    let row: ReturnType<typeof createPlainSessionCurrentProjectionRecordFixture>;
    let failMetadata: boolean;
    const events: string[] = [];
    const address = { kind: 'session', sessionId: 'child' } as const;
    const scope = () => ({ serverId, accountId });
    const draftText = () => {
        const snapshot = getSessionDraftSnapshot(scope(), address);
        return snapshot ? requireComposerDraftDocument(snapshot.document).composer.text.value : undefined;
    };

    beforeEach(async () => {
        installHomeGovernanceBoundaries(homes);
        accountId = 'fork-account-' + ++accountNumber;
        serverId = await homes.addHome({ name: 'Fork Home', serverUrl: 'https://fork-navigation.test', accountId });
        row = createPlainSessionCurrentProjectionRecordFixture({ id: 'child', metadata: {
            path: '/repo', host: 'test',
            forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 0, createdAtMs: 1, strategy: 'replay' },
        } });
        failMetadata = false;
        events.length = 0;
        homes.answer(serverId, 'GET /v2/sessions/child', { select: () => {
            if (!events.includes('hydrate')) events.push('hydrate');
            return { body: { session: row } };
        } });
        homes.answer(serverId, 'PATCH /v2/sessions/child', { select: input => {
            events.push('persist');
            if (failMetadata) return { status: 403, body: { error: 'Forbidden' } };
            const patch = SessionMetadataTuplePatchV1Schema.parse(input);
            if (patch.mode !== 'owner') throw new Error('Expected the fork owner metadata patch');
            row = { ...row, metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
                metadataVersion: patch.sharedMetadata.expectedVersion + 1,
                agentState: patch.agentState.ciphertext, agentStateVersion: patch.agentState.expectedVersion + 1 };
            return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
        } });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://fork-navigation.test', accountId,
            request: homes.request, configureSocket: configureConnectedServerSocketBoundary });
        resetSessionDraftRepositoryForTests();
        await prepareSessionDraftPersistenceStorage();
        events.length = 0;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await connection?.dispose();
        await homes.reset();
        resetSessionDraftRepositoryForTests();
    });

    it('proves the expected child before restoring its draft, navigating, and persisting prompt metadata', async () => {
        const unsubscribe = subscribeSessionDraft(scope(), address, () => {
            if (draftText() === '  retry this  ' && !events.includes('draft')) events.push('draft');
        });
        const navigate = vi.fn(async () => {
            expect(draftText()).toBe('  retry this  ');
            expect(storage.getState().sessions.child).toBeDefined();
            events.push('navigate');
        });
        try {
            await completeSessionForkNavigation({ childSessionId: 'child', parentSessionId: 'parent', serverId,
                navigate, restoredDraftText: '  retry this  ', sourceMessageId: 'm1', writeForkInitialPrompt: true });

            expect(navigate).toHaveBeenCalledWith('child', { serverId });
            expect(readSessionOwnerMetadataView(storage.getState().sessions.child!)?.forkInitialPromptV1).toMatchObject({
                v: 1, text: '  retry this  ', sourceMessageId: 'm1',
            });
            expect(events).toEqual(['hydrate', 'draft', 'navigate', 'persist']);
        } finally { unsubscribe(); }
    });

    it('restores exact inline reference ranges from the source message envelope', async () => {
        const token = '[Auth fix](happier-ref:session:auth)';
        const message: UserTextMessage = { id: 'reference-source', kind: 'user-text', localId: null, createdAt: 1, seq: 7,
            text: `Continue ${token}`, meta: MessageMetaSchema.parse({ happierStructuredInputV1: { v: 1, mentions: [
                { kind: 'happier.session', ref: 'session:auth', label: 'Auth fix', token },
            ] } }) };
        const messagesById = { [message.id]: message };
        storage.setState(state => ({ sessionMessages: { ...state.sessionMessages, parent: {
            messagesById, messagesMap: messagesById, messageIdsOldestFirst: [message.id], messagesVersion: 1,
            reducerState: createReducer(), latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null, isLoaded: true,
        } } }));
        await completeSessionForkNavigation({ childSessionId: 'child', parentSessionId: 'parent', serverId,
            navigate: () => {}, restoredDraftText: message.text, sourceMessageId: message.id });
        const snapshot = getSessionDraftSnapshot(scope(), address);
        if (!snapshot) throw new Error('Expected the restored fork draft');
        expect(requireComposerDraftDocument(snapshot.document).composer.mentions?.value).toEqual([
            expect.objectContaining({ ref: 'session:auth', tokenText: token, start: 9, end: message.text.length }),
        ]);
    });

    it('does not write a restored draft, navigate, or persist prompt metadata for a wrong child', async () => {
        row = createPlainSessionCurrentProjectionRecordFixture({ id: 'child', metadata: {
            path: '/repo', host: 'test',
            forkV1: { v: 1, parentSessionId: 'another-parent', parentCutoffSeqInclusive: 0, createdAtMs: 1, strategy: 'replay' },
        } });
        const navigate = vi.fn();
        await expect(completeSessionForkNavigation({ childSessionId: 'child', parentSessionId: 'parent', serverId,
            navigate, restoredDraftText: 'retry this', writeForkInitialPrompt: true }))
            .rejects.toThrow(CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR);

        expect(getSessionDraftSnapshot(scope(), address)).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
        expect(events).toEqual(['hydrate']);
    });

    it('propagates required metadata persistence failure after navigation even when local draft storage fails', async () => {
        failMetadata = true;
        // Device persistence is the genuine boundary; draft mutation and navigation remain real.
        const persistence: { set(key: string, value: string): void } = getSessionDraftPersistenceStorage();
        const set = persistence.set.bind(persistence);
        vi.spyOn(persistence, 'set').mockImplementation((key, value) => {
            if (key.startsWith('session-drafts-repository-v1:')) throw new Error('local draft unavailable');
            return set(key, value);
        });
        const navigate = vi.fn(async () => { events.push('navigate'); });

        await expect(completeSessionForkNavigation({ childSessionId: 'child', parentSessionId: 'parent', serverId,
            navigate, restoredDraftText: 'retry this', writeForkInitialPrompt: true }))
            .rejects.toMatchObject({ code: 'forbidden' });
        expect(navigate).toHaveBeenCalledWith('child', { serverId });
        expect(events).toEqual(['hydrate', 'navigate', 'persist']);
    });
});
