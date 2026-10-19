import { describe, expect, it, vi } from 'vitest';

import type {
    DiscussionCreateResultV1,
    DiscussionListResultV1,
    DiscussionOpenedMessageV1,
    DiscussionOpenedSummaryV1,
    DiscussionReadResultV1,
} from '@happier-dev/protocol';
import type { DiscussionDraftSubmission } from './discussionRepository';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DiscussionOpenedMessageV1Schema, DiscussionListResultV1Schema, DiscussionDetailsResultV1Schema,
    DiscussionReadResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createDiscussionActionAdapter, type DiscussionClientOutcome } from '@/sync/api/discussions/discussionActions';
import { Encryption } from '@/sync/encryption/encryption';
import { createResourceDataKey } from '@/sync/encryption/resourceDataKey';
import { resourceStoredContentContext } from '@/sync/encryption/resourceStoredContent';
import { sealSessionStoredContent } from '@happier-dev/sync-client';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { DiscussionCreateRequestV1Schema, type DiscussionCreateRequestV1, type DiscussionCreateResponseV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionCreateResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionAccessGrantsListResponseV1Schema, DiscussionAccessGrantMutationResponseV1Schema, DiscussionLeaveResponseV1Schema } from '@happier-dev/protocol/discussions/access';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';

import { createDiscussionRepository, selectDiscussionListSearch, type DiscussionRepositoryClient } from './discussionRepository';
import { publishMountedDiscussionChanges } from '@/sync/domains/discussions/discussionChangeWatch';
import {
    clearDiscussionRepositoryRegistryForTests,
    getDiscussionRepository,
} from './discussionRepositoryRegistry';

const address = { serverId: 'home-a' } as const;
const scope = { serverId: address.serverId, accountId: 'account-a' } as const;

function draftSubmission(kind: 'newDiscussion' | 'discussion' = 'newDiscussion'): DiscussionDraftSubmission {
    return {
        scope: { serverId: address.serverId, accountId: 'account-a' },
        address: kind === 'newDiscussion'
            ? { kind }
            : { kind, discussionId: 'discussion-a' },
        currentness: {
            address: kind === 'newDiscussion'
                ? { kind }
                : { kind, discussionId: 'discussion-a' },
            mutationIds: { 'composer.text': 'text-mutation', 'composer.mentions': 'mentions-mutation' },
        },
    };
}

function summary(id: string, localId: string | null, messageSeq: number): DiscussionOpenedSummaryV1 {
    return {
        id,
        ownerAccountId: scope.accountId,
        encryptionMode: 'plain',
        anchor: null,
        access: 'owner',
        keyReadiness: true,
        dataEncryptionKey: null,
        creationLocalId: localId,
        title: id,
        latestMessage: { id: `${id}-message`, localId: null, seq: messageSeq, authorAccountId: 'account-a', accountActor: { v: 1, accountId: 'account-a', profile: null }, producerV1: null, createdAt: messageSeq },
        messageSeq,
        lastReadSeq: 0,
        unreadCount: messageSeq,
        unreadMentionCount: 0,
        recentAuthorAccountIds: ['account-a'],
        archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    };
}

function message(seq: number, localId: string | null = null, discussionId = 'discussion-a'): DiscussionOpenedMessageV1 {
    const row = { id: `message-${seq}`, discussionId, localId, seq, authorAccountId: 'account-a', accountActor: { v: 1 as const, accountId: 'account-a', profile: null }, producerV1: null,
        content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: `message ${seq}` }] } }, mentionedAccountIds: [], createdAt: seq };
    return DiscussionOpenedMessageV1Schema.parse({ ...row, content: row.content.v,
        messageRef: createDiscussionMessageRefV1({ ...address, discussionId: row.discussionId }, row) });
}

function listResult(discussions: readonly DiscussionOpenedSummaryV1[], nextCursor: string | null): DiscussionListResultV1 {
    return { v: 1, serverId: address.serverId, discussions: [...discussions], nextCursor, incomplete: false };
}

function readResult(messages: readonly DiscussionOpenedMessageV1[], hasMoreOlder: boolean, messageSeq: number, discussionId = 'discussion-a'): DiscussionReadResultV1 {
    return { v: 1, serverId: address.serverId, discussionId, messages: [...messages], hasMoreOlder, messageSeq, incomplete: false };
}

function client(overrides: Partial<DiscussionRepositoryClient> = {}): DiscussionRepositoryClient {
    return {
        attention: async () => ({ kind: 'succeeded', value: { v: 1, serverId: address.serverId, discussions: [], nextCursor: null, incomplete: false } }),
        list: vi.fn<DiscussionRepositoryClient['list']>().mockResolvedValue({ kind: 'succeeded', value: listResult([], null) }),
        get: vi.fn<DiscussionRepositoryClient['get']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_found' }),
        read: vi.fn<DiscussionRepositoryClient['read']>().mockResolvedValue({ kind: 'succeeded', value: readResult([], false, 0) }),
        create: vi.fn<DiscussionRepositoryClient['create']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        post: vi.fn<DiscussionRepositoryClient['post']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        rename: vi.fn<DiscussionRepositoryClient['rename']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        archive: vi.fn<DiscussionRepositoryClient['archive']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        restore: vi.fn<DiscussionRepositoryClient['restore']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        readState: vi.fn<DiscussionRepositoryClient['readState']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        participants: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        setParticipantPolicy: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        invite: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        inviteExecutableParticipant: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        removeParticipant: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        leave: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        transferOwner: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        listGrants: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        setGrant: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        removeGrant: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        ...overrides,
    };
}

/** Compose the real resource HTTP/crypto adapter; only its request leaves this process. */
function httpClient(request: (path: string, init?: RequestInit) => Promise<Response>,
    crypto: Partial<Pick<Parameters<typeof createDiscussionActionAdapter>[0], 'accountMode' | 'encryption' | 'ownerContentPublicKeyFingerprint'>> = {}): DiscussionRepositoryClient {
    const execute = createDiscussionActionAdapter({ scope, availability: 'available', accountMode: 'plain', encryption: null, request, ...crypto });
    function opened<T>(schema: { parse(value: unknown): T }, value: unknown): DiscussionClientOutcome<T> {
        if (value && typeof value === 'object' && 'errorCode' in value && typeof value.errorCode === 'string') {
            return { kind: 'failed', errorCode: value.errorCode };
        }
        return { kind: 'succeeded', value: schema.parse(value) };
    }
    const context = { surface: 'ui' as const, serverId: scope.serverId };
    const mutation = async (actionId: 'discussion.invite' | 'discussion.participant.remove' | 'discussion.participant.policy.set' | 'discussion.owner.transfer'
        | 'discussion.access.grants.set' | 'discussion.access.grants.remove', input: unknown, signal?: AbortSignal) =>
        opened(DiscussionAccessGrantMutationResponseV1Schema, await execute({ actionId, input, context, signal }));
    return client({
        list: async (input = {}, signal) => opened(DiscussionListResultV1Schema, await execute({ actionId: 'discussion.list', input, context, signal })),
        get: async (discussionId, signal) => opened(DiscussionDetailsResultV1Schema, await execute({ actionId: 'discussion.get', input: { discussionId }, context, signal })),
        read: async (discussionId, input = {}, signal) => opened(DiscussionReadResultV1Schema, await execute({ actionId: 'discussion.read', input: { discussionId, ...input }, context, signal })),
        create: async (input, signal) => opened(DiscussionCreateResultV1Schema, await execute({ actionId: 'discussion.create', input: {
            creationLocalId: input.creationLocalId, title: input.title, anchor: input.anchor, participants: input.participants ? [...input.participants] : undefined,
            firstMessage: { localId: input.messageLocalId, content: input.content,
                mentionedAccountIds: input.mentionedAccountIds === undefined ? undefined : [...input.mentionedAccountIds],
                mentionedSessionIds: input.mentionedSessionIds === undefined ? undefined : [...input.mentionedSessionIds], replyTarget: input.replyTarget },
        }, context, signal })),
        participants: async (discussionId, signal) => opened(DiscussionParticipantsListResponseV1Schema, await execute({ actionId: 'discussion.participants.list', input: { discussionId }, context, signal })),
        listGrants: async (discussionId, signal) => opened(DiscussionAccessGrantsListResponseV1Schema, await execute({ actionId: 'discussion.access.grants.list', input: { discussionId }, context, signal })),
        invite: (input, signal) => mutation('discussion.invite', input, signal),
        removeParticipant: (input, signal) => mutation('discussion.participant.remove', input, signal),
        setParticipantPolicy: (input, signal) => mutation('discussion.participant.policy.set', input, signal),
        transferOwner: (input, signal) => mutation('discussion.owner.transfer', input, signal),
        setGrant: (input, signal) => mutation('discussion.access.grants.set', input, signal),
        removeGrant: (input, signal) => mutation('discussion.access.grants.remove', input, signal),
        leave: async (discussionId, signal) => opened(DiscussionLeaveResponseV1Schema, await execute({ actionId: 'discussion.leave', input: { discussionId }, context, signal })),
    });
}

function storedSummary(id: string) {
    const { title, ...row } = summary(id, null, 1);
    return DiscussionSummaryV1Schema.parse({ ...row, titleContent: { t: 'plain', v: { v: 1, title } } });
}

function storedMessage(discussionId: string, seq: number) {
    const { messageRef: _messageRef, content, ...row } = message(seq, null, discussionId);
    return { ...row, content: { t: 'plain' as const, v: content } };
}

function storedProposalMessage(discussionId: string, seq: number) {
    return { ...storedMessage(discussionId, seq), content: { t: 'plain' as const, v: { kind: 'doc_edit_proposal' as const, proposal: {
        target: { ref: { kind: 'doc' as const, serverId: scope.serverId, artifactId: 'doc-a' }, revision: { headerVersion: 1, bodyVersion: 1 },
            range: { start: 0, end: 6 }, quote: 'Before' }, baseRevision: { headerVersion: 1, bodyVersion: 1 },
        before: 'Before', after: 'After', reason: 'Review' } } } };
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Discussion repository', () => {
    function docRootHistory(rootKind: 'comment' | 'closed') {
        const root = storedProposalMessage('discussion-a', 1);
        const rootMessage = rootKind === 'closed' ? { ...root, docEditProposalDispositionV1: {
            state: 'declined', decidedBy: { accountId: scope.accountId, atMs: 10 } } }
            : { ...storedMessage('discussion-a', 1), content: { t: 'plain' as const, v: {
                kind: 'doc_passage_comment' as const, passage: root.content.v.proposal.target,
                content: { v: 1, parts: [{ t: 'text', text: 'A passage comment' }] } } } };
        // The real C3 query omits independently withheld Doc rows and fills the
        // page with readable history; sequence contiguity is not a paging fact.
        const rows = Array.from({ length: 100 }, (_, index) => index === 0 ? rootMessage : storedMessage('discussion-a', index + 1))
            .filter(row => row.seq !== 90);
        const requests: URL[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            const row = { ...storedSummary('discussion-a'), messageSeq: 100, latestMessage: {
                ...storedSummary('discussion-a').latestMessage, id: 'message-100', seq: 100 } };
            if (url.pathname === '/v1/discussions') return response({ discussions: [{ ...row, anchor: { kind: 'doc', doc: {
                ref: root.content.v.proposal.target.ref, revision: root.content.v.proposal.target.revision } }, firstMessage: rootMessage }], nextCursor: null });
            if (!url.pathname.endsWith('/messages')) return response({ discussion: row });
            requests.push(url);
            const after = url.searchParams.get('afterSeq');
            const before = url.searchParams.get('beforeSeq');
            const messages = after !== null ? rows.filter(message => message.seq > Number(after)).slice(0, 20)
                : rows.filter(message => before === null || message.seq < Number(before)).slice(-20);
            return response({ messages, hasMoreOlder: (messages[0]?.seq ?? 1) > 1, messageSeq: 100 });
        }) });
        return { repository, requests, rows };
    }

    it.each(['comment', 'closed'] as const)('pages missing history and focuses an older message after a scoped %s root joins a loaded tail', async rootKind => {
        const { repository, requests, rows } = docRootHistory(rootKind);
        await repository.refreshDiscussion('discussion-a');
        const tail = repository.getSnapshot().threads['discussion-a']!.messages;
        expect(tail[0]?.seq).toBe(80);
        expect(tail).toHaveLength(20);
        await repository.readList({ state: 'active', anchorDocArtifactId: 'doc-a' });
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']!.messages.map(row => row.seq)).toEqual([1, ...tail.map(row => row.seq)]);
        expect(repository.getSnapshot().threads['discussion-a']!.messages.at(-1)).toBe(tail.at(-1));
        const focused = await repository.openMessage(message(25).messageRef);
        expect(focused?.seq).toBe(25);
        for (let page = 0; page < 5 && repository.getSnapshot().threads['discussion-a']!.hasMoreOlder; page += 1) {
            await repository.loadOlderMessages('discussion-a');
        }
        expect(repository.getSnapshot().threads['discussion-a']!.messages.map(row => row.seq)).toEqual(rows.map(row => row.seq));
        expect(repository.getSnapshot().threads['discussion-a']!.hasMoreOlder).toBe(false);
        expect(requests.filter(url => url.searchParams.has('beforeSeq')).map(url => Number(url.searchParams.get('beforeSeq')))).toEqual([80, 60, 40, 20]);
    });

    it('keeps a cold immutable Doc root tail-lazy while retaining access to its missing older history', async () => {
        const { repository, requests } = docRootHistory('comment');
        await repository.readList({ state: 'active', anchorDocArtifactId: 'doc-a' });
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']!.messages.map(row => row.seq)).toEqual([
            1, ...Array.from({ length: 21 }, (_, index) => index + 80).filter(seq => seq !== 90),
        ]);
        expect(repository.getSnapshot().threads['discussion-a']!.hasMoreOlder).toBe(true);
        expect(requests.map(url => url.search)).toEqual(['']);
        await repository.loadOlderMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']!.messages.some(row => row.seq === 60)).toBe(true);
    });

    it('refreshes accepted and declined proposals on older retained pages from the existing Discussion change', async () => {
        const proposal = storedProposalMessage('discussion-a', 3).content.v;
        let decided = false;
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            const stored = storedSummary('discussion-a');
            const row = { ...stored, messageSeq: 8, latestMessage: { ...stored.latestMessage, id: 'message-8', seq: 8 } };
            if (url.pathname === '/v1/discussions') return response({ discussions: url.searchParams.get('state') === 'archived' ? [] : [row], nextCursor: null });
            if (!url.pathname.endsWith('/messages')) return response({ discussion: row });
            const rows = Array.from({ length: 8 }, (_, index) => {
                const seq = index + 1;
                return seq === 3 || seq === 6 ? { ...storedProposalMessage('discussion-a', seq),
                    docEditProposalDispositionV1: !decided ? { state: 'open' } : seq === 3
                        ? { state: 'accepted', acceptedRevision: { headerVersion: 1, bodyVersion: 2 }, decidedBy: { accountId: scope.accountId, atMs: 10 } }
                        : { state: 'declined', decidedBy: { accountId: scope.accountId, atMs: 10 } } } : storedMessage('discussion-a', seq);
            });
            const after = url.searchParams.get('afterSeq');
            const before = url.searchParams.get('beforeSeq');
            const messages = after !== null ? rows.filter(row => row.seq > Number(after)).slice(0, 2)
                : rows.filter(row => before === null || row.seq < Number(before)).slice(-2);
            return response({ messages, hasMoreOlder: (messages[0]?.seq ?? 1) > 1, messageSeq: 8 });
        }) });
        await repository.refreshDiscussion('discussion-a');
        await repository.loadOlderMessages('discussion-a');
        await repository.loadOlderMessages('discussion-a');
        const previous = repository.getSnapshot().threads['discussion-a']!;
        expect(previous.messages.map(row => row.seq)).toEqual([3, 4, 5, 6, 7, 8]);
        expect(previous.hasMoreOlder).toBe(true);
        const unchanged = previous.messages.find(row => row.seq === 4);
        const unmount = repository.mount();
        try {
            decided = true;
            publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 10 }] });
            await vi.waitFor(() => expect(repository.getSnapshot().threads['discussion-a']?.messages.filter(row => row.docEditProposalDispositionV1)
                .map(row => row.docEditProposalDispositionV1?.state)).toEqual(['accepted', 'declined']));
            const current = repository.getSnapshot().threads['discussion-a']!;
            expect(current.messages.map(row => row.seq)).toEqual([3, 4, 5, 6, 7, 8]);
            expect(current.hasMoreOlder).toBe(true);
            expect(current.messages.find(row => row.seq === 4)).toBe(unchanged);
            expect(current.messages.filter(row => row.docEditProposalDispositionV1).map(row => row.content)).toEqual([proposal, proposal]);
        } finally { unmount(); }
    });

    it('does not reopen a settled proposal when an older HTTP read finishes after its decision read', async () => {
        let decided = false;
        let pauseRead = false;
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            if (!path.includes('/messages')) return response({ discussion: storedSummary('discussion-a') });
            const disposition = decided ? { state: 'declined', decidedBy: { accountId: scope.accountId, atMs: 10 } } : { state: 'open' };
            const messages = [{ ...storedProposalMessage('discussion-a', 1), docEditProposalDispositionV1: disposition }];
            if (pauseRead) { pauseRead = false; entered.resolve(); await release.promise; }
            return response({ messages, hasMoreOlder: false, messageSeq: 1 });
        }) });
        await repository.refreshDiscussion('discussion-a');
        pauseRead = true;
        const stale = repository.refreshMessages('discussion-a');
        await entered.promise;
        decided = true;
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']?.messages[0]?.docEditProposalDispositionV1?.state).toBe('declined');
        release.resolve();
        await stale;
        expect(repository.getSnapshot().threads['discussion-a']?.messages[0]?.docEditProposalDispositionV1?.state).toBe('declined');
    });

    it('does not restore an unreadable settled root from a delayed open scoped list and recovers through a current authorized read', async () => {
        let settled = false;
        let readable = true;
        let pauseList = false;
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const root = () => ({ ...storedProposalMessage('discussion-a', 1),
            ...(readable ? {} : { content: { t: 'encrypted' as const, c: 'unreadable-with-current-resource-key' } }),
            docEditProposalDispositionV1: settled
                ? { state: 'declined', decidedBy: { accountId: scope.accountId, atMs: 10 } } : { state: 'open' } });
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions') {
                const row = { ...storedSummary('discussion-a'), anchor: { kind: 'doc', doc: {
                    ref: { kind: 'doc', serverId: scope.serverId, artifactId: 'doc-a' }, revision: { headerVersion: 1, bodyVersion: 1 } } }, firstMessage: root() };
                if (pauseList) { pauseList = false; entered.resolve(); await release.promise; }
                return response({ discussions: [row], nextCursor: null });
            }
            if (url.pathname.endsWith('/messages')) return response({ messages: [root()], hasMoreOlder: false, messageSeq: 1 });
            return response({ discussion: storedSummary('discussion-a') });
        }) });
        const input = { state: 'active' as const, anchorDocArtifactId: 'doc-a' };
        expect((await repository.readList(input)).kind).toBe('succeeded');
        pauseList = true;
        const oldList = repository.readList(input);
        await entered.promise;
        settled = true;
        readable = false;
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']?.summary?.firstMessage).toMatchObject({
            content: null, docEditProposalDispositionV1: { state: 'declined' } });
        expect(JSON.stringify(repository.getSnapshot())).not.toContain('Before');
        release.resolve();
        await oldList;
        expect(JSON.stringify(repository.getSnapshot())).not.toContain('Before');
        readable = true;
        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']?.summary?.firstMessage).toMatchObject({
            content: { kind: 'doc_edit_proposal' }, docEditProposalDispositionV1: { state: 'declined' } });
    });

    it('keeps detail backfills separate from list query completion and recovers full membership', async () => {
        let refuseList = false;
        let archived = false;
        let pendingList: Promise<void> | null = null;
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions') {
                if (refuseList) return response({ error: 'outcome_unknown' }, 503);
                if (pendingList) await pendingList;
                return response({ discussions: url.searchParams.get('state') === 'archived' ? []
                    : [storedSummary('discussion-a'), storedSummary('discussion-b')], nextCursor: null });
            }
            if (url.pathname.endsWith('/messages')) return response({ messages: [storedMessage('discussion-a', 1)], hasMoreOlder: false, messageSeq: 1 });
            return response({ discussion: { ...storedSummary('discussion-a'), archivedAt: archived ? 1 : null } });
        }) });

        // A phone opens a selected thread before its Home list is demanded.
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'idle', items: [{ id: 'discussion-a' }] });
        await repository.refreshList('active');
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'ready', items: [{ id: 'discussion-a' }, { id: 'discussion-b' }] });
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().lists.active.status).toBe('ready');
        expect(repository.getSnapshot().lists.active.items).toHaveLength(2);

        refuseList = true;
        await repository.refreshList('active');
        const failed = repository.getSnapshot().lists.active;
        expect(failed.status).not.toBe('ready');
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: failed.status, errorCode: failed.errorCode });

        refuseList = false;
        const responseReady = createDeferred<void>();
        pendingList = responseReady.promise;
        const refreshing = repository.refreshList('active');
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().lists.active.status).toBe('loading');
        responseReady.resolve();
        await refreshing;
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'ready', errorCode: null,
            items: [{ id: 'discussion-a' }, { id: 'discussion-b' }] });
        expect(repository.getSnapshot().archivedExistence).toBe('empty');
        archived = true;
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'ready', items: [{ id: 'discussion-b' }] });
        expect(repository.getSnapshot().lists.archived).toMatchObject({ status: 'idle', items: [{ id: 'discussion-a' }] });
        expect(repository.getSnapshot().archivedExistence).toBe('present');
    });

    it('does not append an older attention page over a newer owner disposition refresh', async () => {
        const first = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
        const refreshed = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
        const older = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
        const open = { v: 1 as const, serverId: address.serverId, discussions: [{ discussion: summary('discussion-a', null, 1),
            occurrences: [{ message: message(1), type: 'decision' as const }] }], nextCursor: 'older', incomplete: false };
        const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(refreshed.promise).mockReturnValueOnce(older.promise);
        const repository = createDiscussionRepository({ scope, address, client: client({ attention }) });
        const unmount = repository.mount({ attention: true });
        try {
            const initial = repository.refreshAttention();
            publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1 }] });
            const more = repository.loadMoreAttention();
            first.resolve({ kind: 'succeeded', value: open });
            await initial;
            await vi.waitFor(() => expect(attention.mock.calls.length).toBeGreaterThanOrEqual(2));
            refreshed.resolve({ kind: 'succeeded', value: { ...open, discussions: [], nextCursor: null } });
            await vi.waitFor(() => expect(repository.getSnapshot().attention.discussions).toEqual([]));
            older.resolve({ kind: 'succeeded', value: { ...open, nextCursor: null } });
            await more;
            expect(repository.getSnapshot().attention.discussions).toEqual([]);
        } finally { unmount(); }
    });
    it('does not hydrate a previously viewed thread on Doc changes when only Inbox attention remains mounted', async () => {
        const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockResolvedValue({ kind: 'succeeded', value: {
            v: 1, serverId: address.serverId, discussions: [], nextCursor: null, incomplete: false,
        } });
        const network = client({ attention,
            get: vi.fn<DiscussionRepositoryClient['get']>().mockResolvedValue({ kind: 'succeeded', value: {
                v: 1, serverId: address.serverId, discussion: summary('discussion-a', null, 1),
            } }),
            read: vi.fn<DiscussionRepositoryClient['read']>().mockResolvedValue({ kind: 'succeeded', value: readResult([message(1)], false, 1) }) });
        const repository = createDiscussionRepository({ scope, address, client: network });
        const leaveDetail = repository.mount();
        await repository.refreshDiscussion('discussion-a');
        leaveDetail();
        expect(repository.getSnapshot().threads['discussion-a']?.messages).toHaveLength(1);
        vi.mocked(network.get).mockClear();
        vi.mocked(network.read).mockClear();
        const leaveInbox = repository.mount({ attention: true });
        try {
            publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'artifact', entityId: 'plan', changedAt: 1 }] });
            await vi.waitFor(() => expect(repository.getSnapshot().attention.status).toBe('ready'));
            expect(network.get).not.toHaveBeenCalled();
            expect(network.read).not.toHaveBeenCalled();
            expect(network.list).not.toHaveBeenCalled();
        } finally { leaveInbox(); }
    });
    it.each(['discussion', 'artifact'] as const)('rereads an owner %s change invalidated while the prior attention snapshot is still in flight', async kind => {
        const pending = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
        const old = { v: 1 as const, serverId: address.serverId, discussions: [{ discussion: summary('discussion-a', null, 1),
            occurrences: [{ message: message(1), type: 'decision' as const }] }], nextCursor: null, incomplete: false };
        const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockReturnValueOnce(pending.promise)
            .mockResolvedValue({ kind: 'succeeded', value: { ...old, discussions: [] } });
        const repository = createDiscussionRepository({ scope, address, client: client({ attention }) });
        const unmount = repository.mount({ attention: true });
        try {
            const read = repository.refreshAttention();
            publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind, entityId: 'discussion-a', changedAt: 1 }] });
            pending.resolve({ kind: 'succeeded', value: old });
            await read;
            await vi.waitFor(() => expect(repository.getSnapshot().attention.discussions).toEqual([]));
        } finally { unmount(); }
    });
    it('batches cold attention demand, keeps unchanged identities and refreshes only its captured Home/Account', async () => {
        const pending = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
        const value = { v: 1 as const, serverId: address.serverId, discussions: [{ discussion: summary('discussion-a', null, 1),
            occurrences: [{ message: message(1), type: 'decision' as const }] }], nextCursor: null, incomplete: false };
        const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockReturnValueOnce(pending.promise)
            .mockResolvedValue({ kind: 'succeeded', value });
        const network = client({ attention });
        const repository = createDiscussionRepository({ scope, address, client: network });
        const unmount = repository.mount({ attention: true });
        try {
            const first = repository.refreshAttention();
            const second = repository.refreshAttention();
            expect(second).toBe(first);
            pending.resolve({ kind: 'succeeded', value });
            await first;
            const before = repository.getSnapshot().attention.discussions;
            expect(repository.getSnapshot().threads).toEqual({});
            publishMountedDiscussionChanges({ ...scope, serverId: 'other-home', changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1 }] });
            publishMountedDiscussionChanges({ ...scope, accountId: 'other-person', changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1 }] });
            expect(attention).toHaveBeenCalledTimes(1);
            publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 2, kind: 'discussion', entityId: 'discussion-a', changedAt: 2 }] });
            await vi.waitFor(() => expect(repository.getSnapshot().attention.status).toBe('ready'));
            expect(attention).toHaveBeenCalledTimes(2);
            expect(repository.getSnapshot().attention.discussions).toBe(before);
            expect(network.list).not.toHaveBeenCalled();
            expect(network.read).not.toHaveBeenCalled();
        } finally { unmount(); }
    });

    it('does not resurrect retired or explicitly refused attention from an in-flight read', async () => {
        const pending = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
        const value = { v: 1 as const, serverId: address.serverId, discussions: [{ discussion: summary('discussion-a', null, 1),
            occurrences: [{ message: message(1), type: 'decision' as const }] }], nextCursor: null, incomplete: false };
        const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockResolvedValueOnce({ kind: 'succeeded', value })
            .mockReturnValueOnce(pending.promise).mockResolvedValue({ kind: 'failed', errorCode: 'discussion_read_denied' });
        const repository = createDiscussionRepository({ scope, address, client: client({ attention }) });
        await repository.refreshAttention();
        const stale = repository.refreshAttention();
        repository.clear();
        pending.resolve({ kind: 'succeeded', value });
        await stale;
        expect(repository.getSnapshot().attention.discussions).toEqual([]);
        await repository.refreshAttention();
        expect(repository.getSnapshot().attention).toMatchObject({ status: 'revoked', discussions: [] });
    });
    it('opens the exact qualified root across older pages and hides it when its Doc source becomes unavailable', async () => {
        const root = storedMessage('discussion-a', 1);
        let denied = false;
        const requests: string[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path) => {
            requests.push(path);
            if (denied) return response({ error: 'discussion_content_unavailable' }, 409);
            if (path === '/v1/discussions/discussion-a') return response({ discussion: { ...storedSummary('discussion-a'), messageSeq: 3 } });
            const url = new URL(path, 'https://home.invalid');
            const older = url.searchParams.has('beforeSeq');
            return response({ messages: older ? [root, storedMessage('discussion-a', 2)] : [storedMessage('discussion-a', 3)],
                hasMoreOlder: !older, messageSeq: 3 });
        }) });
        const ref = createDiscussionMessageRefV1({ ...address, discussionId: 'discussion-a' }, root);
        expect(await repository.openMessage(ref)).toMatchObject({ id: root.id, messageRef: ref });
        expect(requests.some(path => path.includes('beforeSeq=3'))).toBe(true);
        const count = requests.length;
        expect(await repository.openMessage({ ...ref, discussion: { ...ref.discussion, serverId: 'other-home' } })).toBeNull();
        expect(requests).toHaveLength(count);
        denied = true;
        expect(await repository.openMessage(ref)).toBeNull();
        expect(repository.getSnapshot().threads['discussion-a']?.messages).toEqual([]);
    });

    it('projects a Home collection refusal to existing and newly demanded anchor collections', async () => {
        let denied = false;
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async () => denied
            ? response({ error: 'discussion_read_denied' }, 403)
            : response({ discussions: [{ ...storedSummary('discussion-a'), anchor: { kind: 'session', sessionId: 'anchor-a' } }], nextCursor: null })) });
        await repository.refreshAnchoredList('anchor-a', 'active');
        expect(repository.getListSnapshot('anchor-a').lists.active.items.map(row => row.id)).toEqual(['discussion-a']);
        denied = true;
        await repository.refreshAnchoredList('anchor-a', 'active');
        for (const anchor of ['anchor-a', 'anchor-new']) {
            expect(repository.getListSnapshot(anchor)).toMatchObject({
                lists: { active: { items: [], status: 'revoked', errorCode: 'discussion_read_denied' },
                    archived: { items: [], status: 'revoked', errorCode: 'discussion_read_denied' } },
                archivedExistence: 'unknown',
            });
        }
    });

    it('projects ownership changes and retires only the resource left through real management HTTP', async () => {
        let ownerAccountId: string = scope.accountId;
        let left = false;
        const roster = () => ({ discussionId: 'discussion-a', ownerAccountId, access: ownerAccountId === scope.accountId ? 'owner' : 'admin',
            grants: [{ principal: { kind: 'account', accountId: 'account-b' }, accessLevel: 'edit',
                createdByAccountId: scope.accountId, createdAt: 1, display: { name: 'B' } }] });
        const currentSummary = () => ({ ...storedSummary('discussion-a'), ownerAccountId,
            access: ownerAccountId === scope.accountId ? 'owner' : 'admin', capabilities: { ...storedSummary('discussion-a').capabilities,
                leave: ownerAccountId !== scope.accountId } });
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path, init) => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions') return response({ discussions: url.searchParams.get('state') === 'archived' ? []
                : [...(left ? [] : [currentSummary()]), storedSummary('discussion-b')], nextCursor: null });
            if (path.endsWith('/leave')) { left = true; return response({ discussionId: 'discussion-a', access: null, changed: true }); }
            if (left) return response({ error: 'discussion_not_found' }, 404);
            if (path.endsWith('/owner') && init?.method === 'PUT') { ownerAccountId = 'account-b'; return response({ ...roster(), changed: true }); }
            if (path.endsWith('/participants')) return response({ ...roster(), participants: [] });
            if (path.endsWith('/access/grants')) return response(roster());
            if (path.endsWith('/messages')) return response({ messages: [storedMessage('discussion-a', 1)], hasMoreOlder: false, messageSeq: 1 });
            return response({ discussion: currentSummary() });
        }) });
        await repository.refreshList('active');
        expect(await repository.participants('discussion-a')).toMatchObject({ kind: 'succeeded', value: { access: 'owner' } });
        expect(await repository.transferOwner({ discussionId: 'discussion-a', accountId: 'account-b' })).toMatchObject({ kind: 'succeeded', value: { changed: true } });
        expect(repository.getSnapshot().lists.active.items.find(row => row.id === 'discussion-a'))
            .toMatchObject({ ownerAccountId: 'account-b', access: 'admin', capabilities: { leave: true } });
        expect(await repository.leave('discussion-a')).toMatchObject({ kind: 'succeeded', value: { access: null } });
        expect(repository.getSnapshot().lists.active.items.map(row => row.id)).toEqual(['discussion-b']);
        expect(repository.getSnapshot().threads['discussion-a']).toMatchObject({ summary: null, messages: [], status: 'revoked' });
        expect(await repository.listGrants('discussion-a')).toMatchObject({ kind: 'failed', errorCode: 'discussion_not_found' });
    });

    it('changes an executable participant answer policy through the existing Action HTTP contract and fences revoked reads', async () => {
        let answerPolicy = 'when_addressed';
        let revoked = false;
        const roster = () => ({ discussionId: 'discussion-a', ownerAccountId: scope.accountId, access: 'owner', grants: [] });
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path, init) => {
            if (revoked) return response({ error: 'discussion_read_denied' }, 403);
            if (path.endsWith('/participants/policy')) {
                const body = JSON.parse(String(init?.body));
                expect(body.participant).toEqual({ kind: 'session', sessionId: 'agent-session' });
                answerPolicy = body.answerPolicy;
                return response({ ...roster(), changed: true });
            }
            if (path.endsWith('/participants')) return response({ ...roster(), participants: [{
                participant: { kind: 'session', sessionId: 'agent-session' }, answerPolicy, createdAt: 1,
            }] });
            return response({ discussion: storedSummary('discussion-a') });
        }) });
        expect(await repository.setParticipantPolicy({ discussionId: 'discussion-a',
            participant: { kind: 'session', sessionId: 'agent-session' }, answerPolicy: 'reads_only' }))
            .toMatchObject({ kind: 'succeeded', value: { changed: true } });
        expect(await repository.participants('discussion-a')).toMatchObject({ kind: 'succeeded', value: {
            participants: [{ answerPolicy: 'reads_only' }],
        } });
        revoked = true;
        expect(await repository.setParticipantPolicy({ discussionId: 'discussion-a',
            participant: { kind: 'session', sessionId: 'agent-session' }, answerPolicy: 'when_addressed' }))
            .toMatchObject({ kind: 'failed', errorCode: 'discussion_read_denied' });
        expect(repository.getSnapshot().threads['discussion-a']).toMatchObject({ status: 'revoked', summary: null });
    });

    it('reconciles a lost create through the creator-qualified lookup instead of a foreign local-ID collision', async () => {
        const creationLocalId = 'same-creator-local-id';
        const messageLocalId = 'same-message-local-id';
        const own = { ...storedSummary('discussion-a'), creationLocalId };
        const foreign = { ...storedSummary('discussion-foreign'), creationLocalId };
        let committed = false;
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path, init) => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions' && init?.method === 'POST') {
                committed = true;
                throw new TypeError('create response lost after commit');
            }
            if (url.pathname === '/v1/discussions') return response({ discussions: !committed || url.searchParams.get('state') === 'archived' ? []
                : url.searchParams.get('creationLocalId') === creationLocalId ? [own] : [foreign, own], nextCursor: null });
            const discussionId = url.pathname.split('/')[3]!;
            if (url.pathname.endsWith('/messages')) return response({ messages: [{ ...storedMessage(discussionId, 1), localId: messageLocalId }],
                hasMoreOlder: false, messageSeq: 1 });
            return response({ discussion: discussionId === own.id ? own : foreign });
        }) });
        expect(await repository.create({ creationLocalId, messageLocalId, title: 'Mine',
            content: { v: 1, parts: [{ t: 'text', text: 'Mine' }] }, draftSubmission: draftSubmission() })).toMatchObject({ kind: 'checking' });
        await vi.waitFor(() => expect(repository.getSnapshot().mutations[creationLocalId]?.status).toBe('observed_success'));
        expect(repository.getSnapshot().mutations[creationLocalId]?.discussionId).toBe(own.id);
        expect(repository.getSnapshot().threads[foreign.id]).toBeUndefined();
    });

    it('retains an uncertain create with initial people until its original key-delivery lifecycle is retried', async () => {
        const secret = new Uint8Array(32).fill(17);
        const encryption = await Encryption.create(secret);
        const ownerContentPublicKeyFingerprint = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
            material: { type: 'legacy', secret } }).contentPublicKeyFingerprint;
        let stored: DiscussionCreateResponseV1 | null = null;
        let preparationAvailable = false;
        const creates: DiscussionCreateRequestV1[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path, init) => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions' && init?.method === 'GET') return response({
                discussions: stored && url.searchParams.get('state') !== 'archived' ? [stored.discussion] : [], nextCursor: null });
            if (url.pathname === '/v1/discussions' && init?.method === 'POST') {
                const body = DiscussionCreateRequestV1Schema.parse(JSON.parse(String(init.body)));
                creates.push(body);
                stored ??= { discussion: { ...storedSummary('discussion-a'), encryptionMode: 'e2ee', keyReadiness: true,
                    dataEncryptionKey: body.dataEncryptionKey!, creationLocalId: body.creationLocalId, titleContent: body.titleContent },
                    firstMessage: { ...storedMessage('discussion-a', 1), content: body.firstMessage.content,
                        localId: body.firstMessage.localId, mentionedAccountIds: body.firstMessage.mentionedAccountIds ?? [] } };
                return response(stored);
            }
            if (url.pathname.endsWith('/data-key/recipients')) return preparationAvailable
                ? response({ discussionId: 'discussion-a', ownerAccountId: scope.accountId, access: 'owner', encryptionMode: 'e2ee',
                    dataEncryptionKey: stored?.discussion.dataEncryptionKey, callerDataEncryptionKey: stored?.discussion.dataEncryptionKey, recipients: [] })
                : response({ error: 'discussion_content_unavailable' }, 503);
            if (url.pathname.endsWith('/messages')) return response({ messages: stored ? [stored.firstMessage] : [], hasMoreOlder: false, messageSeq: 1 });
            return response({ discussion: stored?.discussion });
        }, { encryption, accountMode: 'e2ee', ownerContentPublicKeyFingerprint }) });
        const outcome = await repository.create({ creationLocalId: 'create-with-people', messageLocalId: 'first-message',
            title: 'Together', content: { v: 1, parts: [{ t: 'text', text: 'Hello' }] },
            participants: [{ kind: 'account', accountId: 'account-b' }], draftSubmission: draftSubmission() });
        expect(outcome.kind).toBe('checking');
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['create-with-people']?.status).not.toBe('checking'));
        expect(repository.getSnapshot().mutations['create-with-people']?.status).toBe('outcome_unknown');
        preparationAvailable = true;
        expect(await repository.retry('create-with-people')).toMatchObject({ kind: 'succeeded', value: { discussion: { id: 'discussion-a' } } });
        expect(creates).toHaveLength(2);
        expect(creates[1]?.dataEncryptionKey).toBe(creates[0]?.dataEncryptionKey);
        expect(creates[1]?.creationLocalId).toBe('create-with-people');
        expect(creates[1]?.firstMessage.localId).toBe('first-message');
    });

    it('retires only the denied resource and keeps an unrelated Home HTTP read current', async () => {
        const oldA = createDeferred<void>();
        const currentB = createDeferred<void>();
        const oldList = createDeferred<void>();
        const listArrived = createDeferred<void>();
        let pendingReads = false;
        let pendingList = false;
        let denied = false;
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path) => {
            const url = new URL(path, 'https://home.invalid');
            if (url.pathname === '/v1/discussions') {
                if (url.searchParams.get('state') === 'archived') return response({ discussions: [], nextCursor: null });
                if (url.searchParams.get('cursor')) {
                    if (pendingList) { listArrived.resolve(); await oldList.promise; }
                    return response({ discussions: [storedSummary('discussion-b')], nextCursor: null });
                }
                return response({ discussions: [storedSummary('discussion-a')], nextCursor: 'home-page-2' });
            }
            const discussionId = url.pathname.split('/')[3]!;
            if (!url.pathname.endsWith('/messages')) return response({ discussion: storedSummary(discussionId) });
            if (discussionId === 'discussion-a' && denied) return response({ error: 'discussion_read_denied' }, 403);
            const seq = pendingReads ? 2 : 1;
            if (pendingReads) await (discussionId === 'discussion-a' ? oldA : currentB).promise;
            return response({ messages: [storedMessage(discussionId, seq)], hasMoreOlder: false, messageSeq: seq });
        }) });
        await repository.refreshList('active');
        await repository.loadMoreList('active');
        await repository.refreshMessages('discussion-a');
        await repository.refreshMessages('discussion-b');
        expect(repository.getSnapshot().threads['discussion-b']?.messages).toHaveLength(1);
        pendingReads = true;
        const staleRead = repository.refreshMessages('discussion-a');
        const neighborRead = repository.refreshMessages('discussion-b');
        pendingList = true;
        const staleList = repository.refreshList('active');
        await listArrived.promise;
        denied = true;
        await repository.refreshMessages('discussion-a');
        oldA.resolve();
        currentB.resolve();
        oldList.resolve();
        await Promise.all([staleRead, neighborRead, staleList]);
        const snapshot = repository.getSnapshot();
        expect(snapshot.lists.active.items.map(row => row.id)).toEqual(['discussion-b']);
        expect(snapshot.threads['discussion-a']?.messages ?? []).toEqual([]);
        expect(snapshot.threads['discussion-b']).toMatchObject({ status: 'ready', messageSeq: 2 });
        expect(snapshot.threads['discussion-b']?.messages.map(row => row.seq)).toEqual([1, 2]);
    });

    it('reads an anchored projection past an unrelated first Home page through the same HTTP repository', async () => {
        const anchored = { ...storedSummary('matching'), anchor: { kind: 'session', sessionId: 'anchor-a' } };
        const reads: string[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            reads.push(path);
            const filtered = url.searchParams.get('anchorSessionId') === 'anchor-a';
            if (url.searchParams.get('anchorSessionId') === 'anchor-b') return response({ discussions: [], nextCursor: null });
            if (url.searchParams.get('state') === 'archived') return response({ discussions: filtered ? [{ ...anchored, id: 'archived', archivedAt: 20 }] : [], nextCursor: null });
            return response({ discussions: filtered ? [{ ...anchored, id: url.searchParams.get('cursor') ? 'matching-page-2' : anchored.id }]
                : [storedSummary('unrelated')], nextCursor: filtered ? url.searchParams.get('cursor') ? null : 'anchor-page-2' : 'home-page-2' });
        }) });
        await repository.refreshList('active');
        await repository.refreshList('active', undefined, 'anchor-a');
        expect(repository.getSnapshot()).toMatchObject({ anchors: { 'anchor-a': { lists: { active: {
            items: [expect.objectContaining({ id: 'matching' })], nextCursor: 'anchor-page-2', status: 'ready',
        } } } } });
        await repository.loadMoreAnchoredList('anchor-a', 'active');
        await repository.refreshAnchoredList('anchor-a', 'archived');
        expect(repository.getListSnapshot('anchor-a').lists.active.items.map(row => row.id)).toEqual(['matching', 'matching-page-2']);
        expect(repository.getListSnapshot('anchor-a').lists.archived.items.map(row => row.id)).toEqual(['archived']);
        expect(repository.getSnapshot().lists.active.items.map(row => row.id)).toEqual(['unrelated']);
        const releaseOld = repository.mount({ anchorSessionId: 'anchor-a' });
        releaseOld();
        const releaseCurrent = repository.mount({ anchorSessionId: 'anchor-b' });
        reads.length = 0;
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'matching', changedAt: 1 }] });
        await vi.waitFor(() => expect(repository.getListSnapshot('anchor-b').lists.active.status).toBe('ready'));
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every(path => new URL(path, 'https://home.invalid').searchParams.get('anchorSessionId') === 'anchor-b')).toBe(true);
        releaseCurrent();
    });

    it('shares one Home repository across optional Session anchors while keeping Accounts and Homes isolated', () => {
        clearDiscussionRepositoryRegistryForTests();
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const first = getDiscussionRepository({ scope, address, client: client() });
        const otherAnchor = getDiscussionRepository({
            scope,
            address: { ...address },
            client: client(),
        });
        const otherAccount = getDiscussionRepository({
            scope: { ...scope, accountId: 'account-b' }, address, client: client(),
        });
        const otherHome = getDiscussionRepository({
            scope: { ...scope, serverId: 'home-b' },
            address: { ...address, serverId: 'home-b' }, client: client(),
        });

        expect(otherAnchor).toBe(first);
        expect(otherAccount).not.toBe(first);
        expect(otherHome).not.toBe(first);
        clearDiscussionRepositoryRegistryForTests();
    });

    it('publishes one stable optimistic message payload before a post settles', async () => {
        let resolvePost: (value: Awaited<ReturnType<DiscussionRepositoryClient['post']>>) => void = () => {
            throw new Error('post resolver was not installed');
        };
        const post = vi.fn<DiscussionRepositoryClient['post']>(() => new Promise((resolve) => {
            resolvePost = resolve;
        }));
        const repository = createDiscussionRepository({ scope, address, client: client({ post }) });
        const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Visible now' }] };

        const pending = repository.post({
            discussionId: 'discussion-a',
            localId: 'post-local-pending',
            content,
            mentionedAccountIds: ['account-b'],
            draftSubmission: draftSubmission('discussion'),
        });

        expect(repository.getSnapshot().mutations['post-local-pending']).toMatchObject({
            localId: 'post-local-pending',
            discussionId: 'discussion-a',
            status: 'sending',
            content,
            mentionedAccountIds: ['account-b'],
        });

        resolvePost({
            kind: 'succeeded',
            value: {
                v: 1,
                serverId: address.serverId,
                
                message: { ...message(1, 'post-local-pending'), content },
                messageSeq: 1,
            },
        });
        await pending;

        const snapshot = repository.getSnapshot();
        expect(snapshot.mutations['post-local-pending']?.status).toBe('observed_success');
        expect(snapshot.threads['discussion-a']?.messages.filter((row) => row.localId === 'post-local-pending')).toHaveLength(1);
    });

    it('purges the denied Discussion projections and mutations on explicit access loss', async () => {
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'succeeded', value: listResult([summary('discussion-a', null, 1)], null) });
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult([message(1)], false, 1) })
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'discussion_read_denied' });
        const post = vi.fn<DiscussionRepositoryClient['post']>()
            .mockResolvedValue({ kind: 'approval_request_created', artifactId: 'approval-a', actionId: 'discussion.post' });
        const repository = createDiscussionRepository({ scope, address, client: client({ list, read, post }) });
        await repository.refreshList('active');
        await repository.refreshMessages('discussion-a');
        await repository.post({
            discussionId: 'discussion-a',
            localId: 'post-local-a',
            content: { v: 1, parts: [{ t: 'text', text: 'Private pending text' }] },
            draftSubmission: draftSubmission('discussion'),
        });

        await repository.refreshMessages('discussion-a');

        expect(repository.getSnapshot()).toMatchObject({
            lists: {
                active: { items: [], status: 'ready', errorCode: null },
                archived: { items: [], status: 'idle', errorCode: null },
            },
            threads: { 'discussion-a': { summary: null, messages: [], status: 'revoked', errorCode: 'discussion_read_denied' } },
            mutations: {},
        });
    });

    it('purges retained decrypted state when a protected refresh nondiscloses the discussion as not found', async () => {
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'succeeded', value: listResult([summary('discussion-a', null, 1)], null) });
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValue({ kind: 'succeeded', value: readResult([message(1)], false, 1) });
        const get = vi.fn<DiscussionRepositoryClient['get']>()
            .mockResolvedValueOnce({
                kind: 'succeeded',
                value: {
                    v: 1,
                    serverId: address.serverId,
                    
                    discussion: summary('discussion-a', null, 1),
                },
            })
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'discussion_not_found' });
        const repository = createDiscussionRepository({ scope, address, client: client({ list, read, get }) });
        await repository.refreshList('active');
        await repository.refreshDiscussion('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']?.messages).toHaveLength(1);

        await repository.refreshDiscussion('discussion-a');

        expect(repository.getSnapshot()).toMatchObject({
            lists: {
                active: { items: [], status: 'ready', errorCode: null },
                archived: { items: [], status: 'idle', errorCode: null },
            },
            threads: { 'discussion-a': { summary: null, messages: [], status: 'revoked', errorCode: 'discussion_not_found' } },
            mutations: {},
        });
    });

    it('retains recoverable projections across a transient list failure', async () => {
        const retained = summary('discussion-a', null, 1);
        // Each active refresh also asks the bounded archived-existence probe.
        const activeOutcomes: Awaited<ReturnType<DiscussionRepositoryClient['list']>>[] = [
            { kind: 'succeeded', value: listResult([retained], null) },
            { kind: 'failed', errorCode: 'offline' },
        ];
        const list = vi.fn<DiscussionRepositoryClient['list']>(async (input) => (
            input?.state === 'archived'
                ? { kind: 'succeeded', value: listResult([], null) }
                : activeOutcomes.shift()!
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ list }) });

        await repository.refreshList('active');
        await repository.refreshList('active');

        expect(repository.getSnapshot().lists.active).toMatchObject({
            items: [retained],
            status: 'offline',
            errorCode: 'offline',
        });
    });

    it('does not let an older in-flight success repopulate state after access loss', async () => {
        let resolveRead: (value: Awaited<ReturnType<DiscussionRepositoryClient['read']>>) => void = () => {
            throw new Error('read resolver was not installed');
        };
        const read = vi.fn<DiscussionRepositoryClient['read']>(() => new Promise((resolve) => {
            resolveRead = resolve;
        }));
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'discussion_read_denied' });
        const repository = createDiscussionRepository({ scope, address, client: client({ list, read }) });

        const staleRefresh = repository.refreshMessages('discussion-a');
        await repository.refreshList('active');
        resolveRead({ kind: 'succeeded', value: readResult([message(1)], false, 1) });
        await staleRefresh;

        expect(repository.getSnapshot()).toMatchObject({
            lists: { active: { status: 'revoked' }, archived: { status: 'revoked' } },
            threads: {},
        });
    });

    it.each(['active', 'archived'] as const)('completes the selected %s corpus for client search through existing HTTP keyset pages', async state => {
        const requests: URL[] = [];
        const row = (id: string) => ({ ...storedSummary(id), archivedAt: state === 'archived' ? 20 : null });
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            requests.push(url);
            if (url.searchParams.get('state') !== state) return response({ discussions: [], nextCursor: null });
            const cursor = url.searchParams.get('cursor');
            return response(cursor === 'page-3'
                ? { discussions: [row('last-page-match')], nextCursor: null }
                : cursor === 'page-2'
                    ? { discussions: [row('middle')], nextCursor: 'page-3' }
                    : { discussions: [row('first')], nextCursor: 'page-2' });
        }) });
        await repository.refreshList(state, undefined, undefined, { complete: true });
        expect(repository.getSnapshot().lists[state].items.map(row => row.id)).toEqual(['first', 'middle', 'last-page-match']);
        expect(repository.getSnapshot().lists[state]).toMatchObject({ status: 'ready', nextCursor: null, incomplete: false });
        expect(requests.filter(url => url.searchParams.get('state') === state).map(url => url.searchParams.get('cursor')))
            .toEqual([null, 'page-2', 'page-3']);
        expect(requests.every(url => [...url.searchParams.keys()].every(key => ['state', 'cursor', 'limit'].includes(key)))).toBe(true);
    });

    it('keeps received search pages visible with the real next frontier when a later page fails', async () => {
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            if (url.searchParams.get('state') === 'archived') return response({ discussions: [], nextCursor: null });
            return url.searchParams.has('cursor') ? response({ error: 'temporary_failure' }, 503)
                : response({ discussions: [storedSummary('known-match')], nextCursor: 'unread-page' });
        }) });
        await repository.refreshList('active', undefined, undefined, { complete: true });
        expect(repository.getSnapshot().lists.active).toMatchObject({
            items: [{ id: 'known-match' }], status: 'error', nextCursor: 'unread-page',
        });
        expect(selectDiscussionListSearch(repository.getSnapshot().lists.active, 'known-match', new Map())).toMatchObject({
            items: [{ id: 'known-match' }], status: 'error', nextCursor: 'unread-page', incomplete: true,
        });
    });

    it('keeps a normal joined page read when its search caller cancels and resumes the same frontier', async () => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const requests: string[] = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            if (url.searchParams.get('state') === 'archived') return response({ discussions: [], nextCursor: null });
            requests.push(url.searchParams.get('cursor') ?? 'first');
            if (!url.searchParams.has('cursor')) { entered.resolve(); await release.promise; }
            return response({ discussions: [storedSummary(url.searchParams.has('cursor') ? 'last' : 'first')],
                nextCursor: url.searchParams.has('cursor') ? null : 'later-page' });
        }) });
        const search = new AbortController();
        const completing = repository.loadCompleteList('active', search.signal);
        await entered.promise;
        const visibleRead = repository.refreshList('active');
        search.abort();
        release.resolve();
        await Promise.all([completing, visibleRead]);
        expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'ready', items: [{ id: 'first' }], nextCursor: 'later-page' });
        expect(requests).toEqual(['first']);
        await repository.loadCompleteList('active');
        expect(repository.getSnapshot().lists.active.items.map(row => row.id)).toEqual(['first', 'last']);
        expect(requests).toEqual(['first', 'later-page']);
        const snapshot = repository.getSnapshot();
        await repository.loadCompleteList('active');
        expect(repository.getSnapshot()).toBe(snapshot);
    });

    it('searches a later-page title opened by the actual resource cipher, never ciphertext or message bodies', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(37));
        const key = await createResourceDataKey({ mode: 'e2ee', encryptDataEncryptionKey: value => encryption.encryptEncryptionKey(value) });
        if (!key || key.mode !== 'e2ee') throw new Error('Expected resource key fixture');
        const title = await sealSessionStoredContent(resourceStoredContentContext(key), { v: 1, title: 'Private payroll review' });
        const body = await sealSessionStoredContent(resourceStoredContentContext(key), { v: 1, parts: [{ t: 'text', text: 'body-only-needle' }] });
        if (title.status !== 'ready' || title.content.t !== 'encrypted' || body.status !== 'ready') throw new Error('Expected sealed resource fixture');
        const opened = { ...storedSummary('opened-title'), encryptionMode: 'e2ee', dataEncryptionKey: key.dataEncryptionKey,
            titleContent: title.content, latestMessage: { ...storedSummary('opened-title').latestMessage, content: body.content } };
        const locked = { ...opened, id: 'locked-title', keyReadiness: false };
        const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async (path, init) => {
            const url = new URL(path, 'https://home.invalid');
            requests.push({ url, init });
            return response({ discussions: url.searchParams.get('state') === 'archived' ? []
                : url.searchParams.has('cursor') ? [opened] : [locked],
                nextCursor: url.searchParams.get('state') === 'archived' || url.searchParams.has('cursor') ? null : 'encrypted-page-2' });
        }, { encryption, accountMode: 'e2ee' }) });
        await repository.loadCompleteList('active');
        const list = repository.getSnapshot().lists.active;
        expect(list.items.map(row => row.title)).toEqual([null, 'Private payroll review']);
        const selected = selectDiscussionListSearch(list, 'PAYROLL', new Map());
        expect(selected.items.map(row => row.id)).toEqual(['opened-title']);
        expect(selected).toMatchObject({ status: 'locked', nextCursor: null, incomplete: true });
        expect(selectDiscussionListSearch(list, title.content.c, new Map()).items).toEqual([]);
        expect(selectDiscussionListSearch(list, 'body-only-needle', new Map()).items).toEqual([]);
        expect(requests.every(({ url, init }) => init?.method === 'GET' && init.body === undefined
            && [...url.searchParams.keys()].every(name => ['state', 'cursor', 'limit'].includes(name)))).toBe(true);
    });

    it('does not publish a later search page or continue traversal after Home retirement', async () => {
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const cursors: Array<string | null> = [];
        const repository = createDiscussionRepository({ scope, address, client: httpClient(async path => {
            const url = new URL(path, 'https://home.invalid');
            const cursor = url.searchParams.get('cursor');
            cursors.push(cursor);
            if (cursor) { entered.resolve(); await release.promise; }
            return response({ discussions: [storedSummary(cursor ? 'retired-private' : 'first')], nextCursor: cursor ? 'must-not-read' : 'later-page' });
        }) });
        const completing = repository.loadCompleteList('active');
        await entered.promise;
        repository.clear();
        const retired = repository.getSnapshot();
        release.resolve();
        await completing;
        expect(repository.getSnapshot()).toBe(retired);
        expect(repository.getSnapshot().lists.active.items).toEqual([]);
        expect(cursors).toEqual([null, 'later-page']);
    });

    it('keeps active and archived keyset pages separate and merges repeated rows stably', async () => {
        const first = summary('discussion-a', null, 3);
        const second = summary('discussion-b', null, 2);
        const activeOutcomes: Awaited<ReturnType<DiscussionRepositoryClient['list']>>[] = [
            { kind: 'succeeded', value: listResult([first], 'next-active') },
            { kind: 'succeeded', value: listResult([first, second], null) },
        ];
        const list = vi.fn<DiscussionRepositoryClient['list']>(async (input) => (
            input?.state === 'archived'
                ? { kind: 'succeeded', value: listResult([{ ...first, archivedAt: 20 }], null) }
                : activeOutcomes.shift()!
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ list }) });

        await repository.refreshList('active');
        const firstReference = repository.getSnapshot().lists.active.items[0];
        await repository.loadMoreList('active');
        expect(repository.getSnapshot().lists.active.items.map(item => item.id)).toEqual(['discussion-a', 'discussion-b']);
        expect(repository.getSnapshot().lists.active.items[0]).toBe(firstReference);
        await repository.refreshList('archived');

        const snapshot = repository.getSnapshot();
        expect(snapshot.lists.active.items.map((item) => item.id)).toEqual(['discussion-b']);
        expect(snapshot.lists.archived.items.map((item) => item.id)).toEqual(['discussion-a']);
        // The active refresh's archived-existence probe is one bounded read, not a page.
        expect(list.mock.calls.map(([input]) => input)).toEqual([
            { state: 'active' },
            { state: 'archived', limit: 1 },
            { state: 'active', cursor: 'next-active' },
            { state: 'archived' },
        ]);
    });

    it('prepends older message pages without disturbing existing row identities', async () => {
        const recent = [message(3), message(4)];
        const older = [message(1), message(2)];
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult(recent, true, 4) })
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult(older, false, 4) });
        const repository = createDiscussionRepository({ scope, address, client: client({ read }) });

        await repository.refreshMessages('discussion-a');
        const recentReference = repository.getSnapshot().threads['discussion-a']!.messages[0];
        await repository.loadOlderMessages('discussion-a');

        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.messages.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
        expect(thread.messages[2]).toBe(recentReference);
        expect(read.mock.calls[1]?.[1]).toEqual({ beforeSeq: 3 });
    });

    it('retains one create identity through outcome-unknown reconciliation and explicit retry', async () => {
        const canonicalSummary = summary('discussion-created', 'create-local-a', 1);
        const created: DiscussionCreateResultV1 = {
            v: 1,
            serverId: address.serverId,
            
            discussion: canonicalSummary,
            firstMessage: { ...message(1, 'message-local-a'), discussionId: 'discussion-created' },
        };
        const create = vi.fn<DiscussionRepositoryClient['create']>()
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'outcome_unknown' })
            .mockResolvedValueOnce({ kind: 'succeeded', value: created });
        const repository = createDiscussionRepository({ scope, address, client: client({ create }) });
        const input = { creationLocalId: 'create-local-a', messageLocalId: 'message-local-a', title: 'Release', content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Ready?' }] }, draftSubmission: draftSubmission() };

        const unknown = await repository.create(input);
        expect(unknown.kind).toBe('checking');
        expect(repository.getSnapshot().mutations['create-local-a']).toMatchObject({ status: 'checking', messageLocalId: 'message-local-a' });
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['create-local-a']).toMatchObject({
            status: 'outcome_unknown',
            errorCode: 'outcome_unknown',
        }));

        const retried = await repository.retry('create-local-a');
        expect(retried.kind).toBe('succeeded');
        const submitted = create.mock.calls.map(([{ onResolvedParticipants: _observe, ...intent }]) => intent);
        expect(submitted).toHaveLength(2);
        expect(submitted[0]).toEqual(submitted[1]);
        expect(repository.getSnapshot().lists.active.items[0]?.id).toBe('discussion-created');
    });

    it('keeps activity order stable when a title-only rename updates an existing summary', async () => {
        const newest = summary('discussion-newest', null, 3);
        const renamed = {
            ...summary('discussion-older', null, 2),
            title: 'Renamed without new activity',
        };
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'succeeded', value: listResult([
                newest,
                { ...renamed, title: 'Original title' },
            ], null) });
        const rename = vi.fn<DiscussionRepositoryClient['rename']>()
            .mockResolvedValue({
                kind: 'succeeded',
                value: {
                    v: 1,
                    serverId: address.serverId,
                    
                    discussion: renamed,
                },
            });
        const repository = createDiscussionRepository({ scope, address, client: client({ list, rename }) });
        await repository.refreshList('active');

        await repository.rename('discussion-older', 'Renamed without new activity');

        expect(repository.getSnapshot().lists.active.items.map((item) => item.id)).toEqual([
            'discussion-newest',
            'discussion-older',
        ]);
        expect(repository.getSnapshot().lists.active.items[1]?.title).toBe('Renamed without new activity');
    });

    it('reconciles an outcome-unknown create from canonical list/read state without resending', async () => {
        const canonicalSummary = summary('discussion-created', 'create-local-a', 1);
        const create = vi.fn<DiscussionRepositoryClient['create']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'outcome_unknown' });
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'succeeded', value: listResult([canonicalSummary], null) });
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValue({
                kind: 'succeeded',
                value: {
                    ...readResult([{ ...message(1, 'message-local-a'), discussionId: 'discussion-created' }], false, 1),
                    discussionId: 'discussion-created',
                },
            });
        const repository = createDiscussionRepository({ scope, address, client: client({ create, list, read }) });

        const outcome = await repository.create({
            creationLocalId: 'create-local-a',
            messageLocalId: 'message-local-a',
            title: 'Release',
            content: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] },
            draftSubmission: draftSubmission(),
        });
        expect(outcome.kind).toBe('checking');
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['create-local-a']?.status).toBe('observed_success'));

        expect(create).toHaveBeenCalledTimes(1);
        expect(repository.getSnapshot().threads['discussion-created']?.messages[0]?.localId).toBe('message-local-a');
        repository.acknowledgeObservedSuccess('create-local-a');
        expect(repository.getSnapshot().mutations['create-local-a']).toBeUndefined();
    });

    it('reconciles an outcome-unknown create whose committed discussion is already archived', async () => {
        const archivedSummary = { ...summary('discussion-created', 'create-local-a', 1), archivedAt: 5 };
        const create = vi.fn<DiscussionRepositoryClient['create']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'outcome_unknown' });
        const list = vi.fn<DiscussionRepositoryClient['list']>()
            .mockImplementation(async (input) => {
                if (!input) throw new Error('expected a scoped discussion list request');
                return {
                    kind: 'succeeded',
                    value: listResult(input.state === 'archived' ? [archivedSummary] : [], null),
                };
            });
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValue({
                kind: 'succeeded',
                value: {
                    ...readResult([{ ...message(1, 'message-local-a'), discussionId: 'discussion-created' }], false, 1),
                    discussionId: 'discussion-created',
                },
            });
        const repository = createDiscussionRepository({ scope, address, client: client({ create, list, read }) });

        const outcome = await repository.create({
            creationLocalId: 'create-local-a',
            messageLocalId: 'message-local-a',
            title: 'Release',
            content: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] },
            draftSubmission: draftSubmission(),
        });
        expect(outcome.kind).toBe('checking');
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['create-local-a']?.status).toBe('observed_success'));

        expect(create).toHaveBeenCalledTimes(1);
        expect(repository.getSnapshot().lists.archived.items.map((item) => item.id)).toEqual(['discussion-created']);
        expect(repository.getSnapshot().lists.active.items).toEqual([]);
        expect(repository.getSnapshot().threads['discussion-created']?.messages[0]?.localId).toBe('message-local-a');
    });

    it('recognizes an outcome-unknown post already published by a racing refresh', async () => {
        const published = { ...message(2, 'post-local-a'), discussionId: 'discussion-a' };
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult([published], false, 2) })
            .mockResolvedValue({ kind: 'succeeded', value: readResult([], false, 2) });
        const post = vi.fn<DiscussionRepositoryClient['post']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'outcome_unknown' });
        const repository = createDiscussionRepository({ scope, address, client: client({ read, post }) });
        await repository.refreshMessages('discussion-a');

        const outcome = await repository.post({
            discussionId: 'discussion-a',
            localId: 'post-local-a',
            content: { v: 1, parts: [{ t: 'text', text: 'Already visible' }] },
            draftSubmission: draftSubmission(),
        });

        expect(outcome.kind).toBe('checking');
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['post-local-a']).toMatchObject({
            status: 'observed_success',
        }));
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('adopts a reload-restored post identity by reconciling before any resend', async () => {
        const published = { ...message(2, 'post-local-restored'), discussionId: 'discussion-a' };
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValue({ kind: 'succeeded', value: readResult([published], false, 2) });
        const post = vi.fn<DiscussionRepositoryClient['post']>();
        const repository = createDiscussionRepository({ scope, address, client: client({ read, post }) });

        repository.adoptPendingIntent({
            kind: 'post',
            discussionId: 'discussion-a',
            localId: 'post-local-restored',
            content: { v: 1, parts: [{ t: 'text', text: 'Restored' }] },
            draftSubmission: draftSubmission('discussion'),
        });

        await vi.waitFor(() => expect(repository.getSnapshot().mutations['post-local-restored']?.status)
            .toBe('observed_success'));
        expect(post).not.toHaveBeenCalled();
    });

    it('separates a dismissable definitive refusal from a retryable transient failure', async () => {
        const post = vi.fn<DiscussionRepositoryClient['post']>()
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'discussion_invalid_mention' })
            .mockResolvedValueOnce({ kind: 'failed', errorCode: 'offline' });
        const repository = createDiscussionRepository({ scope, address, client: client({ post }) });
        const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Keep me' }] };

        await repository.post({ discussionId: 'discussion-a', localId: 'post-definitive', content, draftSubmission: draftSubmission('discussion') });
        await repository.post({ discussionId: 'discussion-a', localId: 'post-transient', content, draftSubmission: draftSubmission('discussion') });

        expect(repository.getSnapshot().mutations['post-definitive']).toMatchObject({
            status: 'failed', errorCode: 'discussion_invalid_mention', recovery: 'dismiss',
        });
        expect(repository.getSnapshot().mutations['post-transient']).toMatchObject({
            status: 'failed', errorCode: 'offline', recovery: 'retry',
        });

        expect(repository.dismissFailure('post-definitive')).toBe(true);
        expect(repository.getSnapshot().mutations['post-definitive']).toBeUndefined();
        await expect(repository.retry('post-definitive')).resolves.toEqual({
            kind: 'failed', errorCode: 'discussion_retry_not_found',
        });
        // Only a settled failure can be dismissed; in-flight and unknown outcomes keep their identity.
        expect(repository.dismissFailure('post-missing')).toBe(false);
        expect(repository.getSnapshot().mutations['post-transient']?.status).toBe('failed');
    });

    it('keeps an approval-pending post visible without claiming success', async () => {
        const post = vi.fn<DiscussionRepositoryClient['post']>().mockResolvedValue({
            kind: 'approval_request_created', artifactId: 'approval-a', actionId: 'discussion.post',
        });
        const repository = createDiscussionRepository({ scope, address, client: client({ post }) });

        const outcome = await repository.post({ discussionId: 'discussion-a', localId: 'post-local-a', content: { v: 1, parts: [{ t: 'text', text: 'Needs approval' }] }, draftSubmission: draftSubmission('discussion') });

        expect(outcome).toEqual({ kind: 'approval_request_created', artifactId: 'approval-a' });
        expect(repository.getSnapshot().mutations['post-local-a']).toMatchObject({ status: 'approval_pending', artifactId: 'approval-a' });
    });

    it('retains remount-adoptable draft currentness until later canonical success is acknowledged', async () => {
        const submission = draftSubmission('discussion');
        const canonical = message(2, 'post-local-remount');
        const post = vi.fn<DiscussionRepositoryClient['post']>().mockResolvedValue({
            kind: 'approval_request_created', artifactId: 'approval-remount', actionId: 'discussion.post',
        });
        const read = vi.fn<DiscussionRepositoryClient['read']>().mockResolvedValue({
            kind: 'succeeded', value: readResult([canonical], false, 2),
        });
        const repository = createDiscussionRepository({ scope, address, client: client({ post, read }) });

        await repository.post({
            discussionId: 'discussion-a',
            localId: 'post-local-remount',
            content: { v: 1, parts: [{ t: 'text', text: 'Survive remount' }] },
            draftSubmission: submission,
        });
        const adopted = repository.getSnapshot().mutations['post-local-remount'];
        expect(adopted).toMatchObject({ status: 'approval_pending', draftSubmission: submission });

        await repository.refreshMessages('discussion-a');
        await vi.waitFor(() => expect(repository.getSnapshot().mutations['post-local-remount']?.status).toBe('observed_success'));
        expect(repository.getSnapshot().mutations['post-local-remount']?.draftSubmission).toBe(submission);
        repository.acknowledgeObservedSuccess('post-local-remount');
        expect(repository.getSnapshot().mutations['post-local-remount']).toBeUndefined();
        expect(post).toHaveBeenCalledOnce();
    });

    it('shares one qualified repository and one mounted watcher lifetime across list and detail consumers', () => {
        clearDiscussionRepositoryRegistryForTests();
        const scope = { serverId: address.serverId, accountId: 'account-a' } as const;
        const repositoryClient = client();
        const first = getDiscussionRepository({ scope, address, client: repositoryClient });
        const second = getDiscussionRepository({ scope, address, client: repositoryClient });

        expect(second).toBe(first);
        const unmountList = first.mount();
        const unmountDetails = second.mount();
        unmountList();
        expect(first.isMounted()).toBe(true);
        unmountDetails();
        expect(first.isMounted()).toBe(false);
        clearDiscussionRepositoryRegistryForTests();
    });

    it('refreshes the shared repository client when its exact-Home runtime is reconstructed', async () => {
        clearDiscussionRepositoryRegistryForTests();
        const scope = { serverId: address.serverId, accountId: 'account-a' } as const;
        const staleList = vi.fn<DiscussionRepositoryClient['list']>();
        const currentList = vi.fn<DiscussionRepositoryClient['list']>()
            .mockResolvedValue({ kind: 'succeeded', value: listResult([summary('discussion-current', null, 1)], null) });
        const first = getDiscussionRepository({ scope, address, client: client({ list: staleList }) });
        const second = getDiscussionRepository({ scope, address, client: client({ list: currentList }) });

        await second.refreshList('active');

        expect(second).toBe(first);
        expect(staleList).not.toHaveBeenCalled();
        expect(currentList).toHaveBeenCalledWith({ state: 'active' }, undefined);
        expect(second.getSnapshot().lists.active.items[0]?.id).toBe('discussion-current');
        clearDiscussionRepositoryRegistryForTests();
    });

    it('refreshes mounted canonical state for any exact-Session AccountChange while retaining the last page', async () => {
        const first = summary('discussion-a', null, 1);
        const refreshed = { ...first, messageSeq: 2, unreadCount: 2 };
        let resolveRefresh: (value: Awaited<ReturnType<DiscussionRepositoryClient['list']>>) => void = () => {
            throw new Error('refresh resolver was not installed');
        };
        const activeOutcomes: Array<() => ReturnType<DiscussionRepositoryClient['list']>> = [
            async () => ({ kind: 'succeeded', value: listResult([first], null) }),
            () => new Promise((resolve) => { resolveRefresh = resolve; }),
        ];
        const list = vi.fn<DiscussionRepositoryClient['list']>((input) => (
            input?.state === 'archived'
                ? Promise.resolve({ kind: 'succeeded' as const, value: listResult([], null) })
                : activeOutcomes.shift()!()
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ list }) });
        await repository.refreshList('active');
        const unmount = repository.mount();

        publishMountedDiscussionChanges({
            serverId: address.serverId, accountId: scope.accountId,
            changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1, hint: { unrelatedSessionProjection: true } }],
        });

        expect(repository.getSnapshot().lists.active).toMatchObject({
            items: [first],
            status: 'loading',
        });
        resolveRefresh({ kind: 'succeeded', value: listResult([refreshed], null) });
        await vi.waitFor(() => expect(repository.getSnapshot().lists.active.items[0]?.messageSeq).toBe(2));
        expect(list.mock.calls.filter(([input]) => input?.state === 'active')).toHaveLength(2);
        unmount();
    });

    it('classifies read-cursor transport failures for state-change retry without treating them as success', async () => {
        const readState = vi.fn<DiscussionRepositoryClient['readState']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'outcome_unknown' });
        const repository = createDiscussionRepository({ scope, address, client: client({ readState }) });

        await expect(repository.setReadState('discussion-a', 4)).resolves.toEqual({
            kind: 'retryable',
            errorCode: 'outcome_unknown',
        });
    });

    it('stops visible-read retries after canonical untracking without purging readable discussion content', async () => {
        const readState = vi.fn<DiscussionRepositoryClient['readState']>()
            .mockResolvedValue({ kind: 'failed', errorCode: 'discussion_not_tracked' });
        const repository = createDiscussionRepository({ scope, address, client: client({ readState }) });

        await expect(repository.setReadState('discussion-a', 4)).resolves.toEqual({
            kind: 'stopped',
            errorCode: 'discussion_not_tracked',
        });
        expect(repository.getSnapshot().lists.active.status).toBe('idle');
    });

    it('merges an overlapping tail read into current thread state instead of its pre-await snapshot', async () => {
        const pendingReads: Array<(value: Awaited<ReturnType<DiscussionRepositoryClient['read']>>) => void> = [];
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult([message(1)], false, 1) })
            .mockImplementation(() => new Promise((resolve) => { pendingReads.push(resolve); }));
        const repository = createDiscussionRepository({ scope, address, client: client({ read }) });
        await repository.refreshMessages('discussion-a');

        const slower = repository.refreshMessages('discussion-a');
        const faster = repository.refreshMessages('discussion-a');
        pendingReads[1]!({ kind: 'succeeded', value: readResult([message(2), message(3)], false, 3) });
        await faster;
        expect(repository.getSnapshot().threads['discussion-a']!.messages.map((row) => row.seq)).toEqual([1, 2, 3]);
        pendingReads[0]!({ kind: 'succeeded', value: readResult([message(2)], false, 2) });
        await slower;

        // Two mounted surfaces refresh the same thread independently; the response
        // that settles second must not delete the messages the other one published.
        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.messages.map((row) => row.seq)).toEqual([1, 2, 3]);
        expect(thread.messageSeq).toBe(3);
    });

    it('keeps the messages a concurrent read published when an overlapping read fails', async () => {
        const pendingReads: Array<(value: Awaited<ReturnType<DiscussionRepositoryClient['read']>>) => void> = [];
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult([message(1)], false, 1) })
            .mockImplementation(() => new Promise((resolve) => { pendingReads.push(resolve); }));
        const repository = createDiscussionRepository({ scope, address, client: client({ read }) });
        await repository.refreshMessages('discussion-a');

        const failing = repository.refreshMessages('discussion-a');
        const succeeding = repository.refreshMessages('discussion-a');
        pendingReads[1]!({ kind: 'succeeded', value: readResult([message(2), message(3)], false, 3) });
        await succeeding;
        pendingReads[0]!({ kind: 'failed', errorCode: 'offline' });
        await failing;

        // A retryable failure reports the failure; it must not republish the thread
        // as it looked before the successful concurrent read landed.
        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.messages.map((row) => row.seq)).toEqual([1, 2, 3]);
        expect(thread.messageSeq).toBe(3);
        expect(thread).toMatchObject({ status: 'offline', errorCode: 'offline' });
    });

    it('completes an older Discussion page against the message that arrived while it was in flight', async () => {
        let resolveOlder: (value: Awaited<ReturnType<DiscussionRepositoryClient['read']>>) => void = () => {
            throw new Error('older read resolver was not installed');
        };
        const read = vi.fn<DiscussionRepositoryClient['read']>()
            .mockResolvedValueOnce({ kind: 'succeeded', value: readResult([message(3)], true, 3) })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }));
        const post = vi.fn<DiscussionRepositoryClient['post']>().mockResolvedValue({
            kind: 'succeeded',
            value: {
                v: 1,
                serverId: address.serverId,
                
                message: message(4, 'post-local-older'),
                messageSeq: 4,
            },
        });
        const repository = createDiscussionRepository({ scope, address, client: client({ read, post }) });
        await repository.refreshMessages('discussion-a');

        const older = repository.loadOlderMessages('discussion-a');
        await repository.post({
            discussionId: 'discussion-a',
            localId: 'post-local-older',
            content: { v: 1, parts: [{ t: 'text', text: 'message 4' }] },
            draftSubmission: draftSubmission('discussion'),
        });
        resolveOlder({ kind: 'succeeded', value: readResult([message(1), message(2)], false, 3) });
        await older;

        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.messages.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
        expect(thread.messageSeq).toBe(4);
        expect(thread.hasMoreOlder).toBe(false);
    });

    it('keeps the fetched summary when an existing Discussion is first opened in a new repository lifetime', async () => {
        // Cold start: the list is loaded, the reader opens an existing Discussion,
        // and its get and read both succeed. Nothing may leave the thread without
        // the summary the get just returned.
        const existing = summary('discussion-a', null, 1);
        const repository = createDiscussionRepository({ scope, address, client: client({
            list: vi.fn<DiscussionRepositoryClient['list']>().mockResolvedValue({ kind: 'succeeded', value: listResult([existing], null) }),
            get: vi.fn<DiscussionRepositoryClient['get']>().mockResolvedValue({
                kind: 'succeeded',
                value: { v: 1, serverId: address.serverId, discussion: existing },
            }),
            read: vi.fn<DiscussionRepositoryClient['read']>().mockResolvedValue({ kind: 'succeeded', value: readResult([message(1)], false, 1) }),
        }) });

        await repository.refreshList('active');
        await repository.refreshDiscussion('discussion-a');

        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.summary).toEqual(existing);
        expect(thread.messages.map((row) => row.seq)).toEqual([1]);
        expect(thread.status).toBe('ready');
    });

    it('reopens retained locked rows through the current cipher once the Session key arrives', async () => {
        const lockedRow = { ...message(1), content: null };
        const readOpened = { current: false };
        const read = vi.fn<DiscussionRepositoryClient['read']>(async (_discussionId, input) => (
            input?.afterSeq === undefined || input.afterSeq === 0
                ? { kind: 'succeeded' as const, value: { ...readResult(readOpened.current ? [message(1)] : [lockedRow], false, 1), incomplete: !readOpened.current } }
                : { kind: 'succeeded' as const, value: readResult([], false, 1) }
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ read }) });

        await repository.refreshMessages('discussion-a');
        expect(repository.getSnapshot().threads['discussion-a']).toMatchObject({ status: 'locked', incomplete: true });
        expect(repository.getSnapshot().threads['discussion-a']!.messages[0]!.content).toBeNull();

        readOpened.current = true;
        await repository.refreshMessages('discussion-a');

        // The adapter discarded the ciphertext, so the retained null row can only be
        // completed by asking the Discussion owner for it again under the new key.
        const thread = repository.getSnapshot().threads['discussion-a']!;
        expect(thread.messages.map((row) => row.content)).toEqual([message(1).content]);
        expect(thread).toMatchObject({ status: 'ready', incomplete: false });
    });

    /**
     * Whether an archived Discussion exists at all is a fact this owner already
     * has a route for. Answering it with one bounded probe beside the active
     * refresh keeps the archived disclosure truthful without preloading a page
     * the reader did not ask for, and without a new wire bit.
     */
    it('answers archived existence from one bounded probe beside the active refresh', async () => {
        const archivedRows = { current: [summary('discussion-archived', null, 1)] };
        const list = vi.fn<DiscussionRepositoryClient['list']>(async (input) => (
            input?.state === 'archived'
                ? { kind: 'succeeded' as const, value: listResult(archivedRows.current, 'archived-page-2') }
                : { kind: 'succeeded' as const, value: listResult([], null) }
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ list }) });

        expect(repository.getSnapshot().archivedExistence).toBe('unknown');
        await repository.refreshList('active');

        // One bounded probe, not a page: the archived list itself stays idle and
        // is still loaded lazily when the reader opens the disclosure.
        expect(list).toHaveBeenCalledWith({ state: 'archived', limit: 1 }, undefined);
        expect(repository.getSnapshot().archivedExistence).toBe('present');
        expect(repository.getSnapshot().lists.archived).toMatchObject({ status: 'idle', items: [] });

        archivedRows.current = [];
        await repository.refreshList('active');
        expect(repository.getSnapshot().archivedExistence).toBe('empty');
    });

    it('never claims archived emptiness from a refused probe', async () => {
        const list = vi.fn<DiscussionRepositoryClient['list']>(async (input) => (
            input?.state === 'archived'
                ? { kind: 'failed' as const, errorCode: 'offline' }
                : { kind: 'succeeded' as const, value: listResult([], null) }
        ));
        const repository = createDiscussionRepository({ scope, address, client: client({ list }) });

        await repository.refreshList('active');

        // An unanswered probe is not an answer: the disclosure keeps offering the
        // archived list rather than telling the reader there is nothing there.
        expect(repository.getSnapshot().archivedExistence).toBe('unknown');
        expect(repository.getSnapshot().lists.active.status).toBe('ready');
    });
});
