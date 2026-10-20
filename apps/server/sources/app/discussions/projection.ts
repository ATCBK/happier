import { DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1, DocEditProposalDispositionV1Schema, type DiscussionCapabilitiesV1, type DiscussionMessageV1, type DiscussionSummaryV1 } from '@happier-dev/protocol/discussions/models';
import { DiscussionMessageContentV1Schema, DiscussionProducerV1StoredSchema, DiscussionTitleV1Schema } from '@happier-dev/protocol/discussions/content';
import { DiscussionMessageAddressingV1Schema } from '@happier-dev/protocol/discussions/participants';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { type SessionMessageAccountActorV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';

import type { DiscussionContext } from './access';
import { DiscussionAnchorV1Schema, DiscussionReplyTargetV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { getActivePrismaRuntime } from "@/storage/prisma";
import type { Tx } from "@/storage/inTx";
import type { Prisma } from '@prisma/client';
import { projectAuthenticatedAccountActorsById } from '@/app/session/messages/projectSessionMessageAccountActors';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';

export type DiscussionStoredContentFailure =
    | "discussion_encryption_mode_mismatch"
    | "discussion_invalid_content";

/**
 * Validates an opaque persisted envelope before any caller can receive it.
 *
 * The resource mode, admitted against its owner's Account mode, is authoritative. A structurally valid envelope
 * of the opposite mode is therefore a typed consistency failure, while an
 * envelope that is not part of the strict wire union is invalid content. The
 * projector may parse only after this check has succeeded in the same
 * transaction.
 */
export function validateDiscussionStoredContent(
    value: unknown,
    storageMode: "plain" | "e2ee",
    semanticKind: "title" | "message",
): DiscussionStoredContentFailure | null {
    const parsed = createStoredReadSchema(StrictSessionStoredMessageContentEnvelopeSchema).safeParse(value);
    if (!parsed.success) return "discussion_invalid_content";
    const expectedKind = storageMode === "e2ee" ? "encrypted" : "plain";
    if (parsed.data.t !== expectedKind) return "discussion_encryption_mode_mismatch";
    if (parsed.data.t === "plain") {
        const semanticSchema = semanticKind === "title"
            ? DiscussionTitleV1Schema
            : DiscussionMessageContentV1Schema;
        if (!createStoredReadSchema(semanticSchema).safeParse(parsed.data.v).success) {
            return "discussion_invalid_content";
        }
    }
    return null;
}

export const DISCUSSION_SELECT = {
    id: true,
    ownerAccountId: true,
    encryptionMode: true,
    dataEncryptionKey: true,
    anchorV1: true,
    anchorSessionId: true,
    creationLocalId: true,
    createdByAccountId: true,
    titleContent: true,
    messageSeq: true,
    lastMessageAt: true,
    archivedAt: true,
} as const;

export const DISCUSSION_MESSAGE_SELECT = {
    id: true,
    discussionId: true,
    localId: true,
    seq: true,
    authorAccountId: true,
    producerV1: true,
    replyTargetV1: true,
    addressingV1: true,
    docEditProposalDispositionV1: true,
    content: true,
    createdAt: true,
    mentions: { select: { accountId: true }, orderBy: { accountId: "asc" } },
} as const;

export type DiscussionRow = Readonly<{
    id: string;
    ownerAccountId: string;
    encryptionMode: string;
    dataEncryptionKey: Uint8Array;
    anchorV1: unknown;
    anchorSessionId: string | null;
    creationLocalId: string;
    createdByAccountId: string | null;
    titleContent: unknown;
    messageSeq: number;
    lastMessageAt: Date;
    archivedAt: Date | null;
}>;

export type DiscussionMessageRow = Readonly<{
    id: string;
    discussionId: string;
    localId: string;
    seq: number;
    authorAccountId: string | null;
    producerV1: unknown;
    replyTargetV1: unknown;
    addressingV1?: unknown;
    docEditProposalDispositionV1?: unknown;
    content: unknown;
    createdAt: Date;
    mentions: readonly Readonly<{ accountId: string }>[];
}>;

export function validateDiscussionStoredMessage(
    row: Pick<DiscussionMessageRow, "content" | "producerV1" | "replyTargetV1" | "addressingV1" | "docEditProposalDispositionV1"> & Partial<Pick<DiscussionMessageRow, "seq">>,
    storageMode: "plain" | "e2ee",
    _discussionId?: string,
): DiscussionStoredContentFailure | null {
    const contentFailure = validateDiscussionStoredContent(row.content, storageMode, "message");
    if (contentFailure) return contentFailure;
    if (row.docEditProposalDispositionV1 != null && !DocEditProposalDispositionV1Schema.safeParse(row.docEditProposalDispositionV1).success) {
        return 'discussion_invalid_content';
    }
    if (row.replyTargetV1 != null && !DiscussionReplyTargetV1Schema.safeParse(row.replyTargetV1).success) {
        return 'discussion_invalid_content';
    }
    if (row.addressingV1 != null) {
        const addressing = DiscussionMessageAddressingV1Schema.safeParse(row.addressingV1);
        if (!addressing.success || addressing.data.throughSeq !== row.seq) return 'discussion_invalid_content';
    }
    if (row.producerV1 === null || row.producerV1 === undefined) return null;
    const producer = DiscussionProducerV1StoredSchema.safeParse(row.producerV1);
    return producer.success
        ? null
        : "discussion_invalid_content";
}

function readEnvelope(value: unknown) {
    return createStoredReadSchema(StrictSessionStoredMessageContentEnvelopeSchema).parse(value);
}

function readProducer(value: unknown) {
    if (value === null || value === undefined) return null;
    return DiscussionProducerV1StoredSchema.parse(value);
}

/** One sanitized, batched projection for admitted message rows and their explicit roster. */
export async function projectDiscussionAccountActorsInTx(tx: Tx, rows: readonly DiscussionMessageRow[], participantAccountIds: readonly string[] = []): Promise<{
    messages: { accountActor: SessionMessageAccountActorV1 | null; requesterAccountActor: SessionMessageAccountActorV1 | null }[];
    participants: (SessionMessageAccountActorV1 | null)[];
}> {
    const requesters = rows.map(row => readProducer(row.producerV1)?.actionRequestAttributionV1?.requester);
    const home = requesters.some(requester => requester != null) ? await readCurrentServerIdentityId(undefined, tx) : null;
    // A matching Account id on another Home is not this Home's person.
    const requesterIds = requesters.map(requester => home && requester?.serverId === home ? requester.accountId : null);
    const actors = await projectAuthenticatedAccountActorsById(tx, [
        ...rows.map(row => row.authorAccountId), ...requesterIds, ...participantAccountIds,
    ]);
    return {
        messages: rows.map((_, index) => ({ accountActor: actors[index] ?? null, requesterAccountActor: actors[rows.length + index] ?? null })),
        participants: actors.slice(rows.length * 2),
    };
}

/**
 * Effective, server-evaluated discussion capabilities.
 *
 * Capabilities project the shared resource grant and current key readiness;
 * they are not a second ACL or inherited source-Session permissions.
 */
export function projectDiscussionCapabilitiesV1(params: Readonly<{
    access: DiscussionContext['access'];
    discussionArchived: boolean;
    keyReadiness?: boolean;
}>): DiscussionCapabilitiesV1 {
    const canSubmit = params.access.level !== 'view' && params.keyReadiness !== false;
    const canManage = params.access.level === 'owner' || params.access.level === 'admin';
    return {
        postMessages: canSubmit && !params.discussionArchived,
        rename: canManage && !params.discussionArchived,
        archive: canManage && !params.discussionArchived,
        restore: canManage && params.discussionArchived,
        askAgent: canSubmit && !params.discussionArchived,
        sendToSession: canSubmit && !params.discussionArchived,
        manageAccess: canManage,
        leave: params.access.level !== 'owner',
    };
}

/** A client-chosen local request identity is projected only back to its author. */
export function projectDiscussionMessageV1(
    row: DiscussionMessageRow,
    viewerAccountId: string,
    accountActor: SessionMessageAccountActorV1 | null,
    requesterAccountActor: SessionMessageAccountActorV1 | null = null,
): DiscussionMessageV1 {
    return {
        id: row.id,
        discussionId: row.discussionId,
        localId: row.authorAccountId === viewerAccountId ? row.localId : null,
        seq: row.seq,
        authorAccountId: row.authorAccountId,
        accountActor,
        requesterAccountActor,
        producerV1: readProducer(row.producerV1),
        ...(row.replyTargetV1 == null ? {} : { replyTarget: DiscussionReplyTargetV1Schema.parse(row.replyTargetV1) }),
        content: readEnvelope(row.content),
        mentionedAccountIds: row.mentions.map((mention) => mention.accountId),
        addressingV1: row.addressingV1 == null ? null : DiscussionMessageAddressingV1Schema.parse(row.addressingV1),
        ...(row.docEditProposalDispositionV1 == null ? {} : { docEditProposalDispositionV1: DocEditProposalDispositionV1Schema.parse(row.docEditProposalDispositionV1) }),
        createdAt: row.createdAt.getTime(),
    };
}

export type DiscussionViewerFacts = Readonly<{
    lastReadSeq: number | null;
    unreadCount: number;
    unreadMentionCount: number;
    recentAuthorAccountIds: readonly string[];
    participantAccountIds: readonly string[];
    participantSessionIds: readonly string[];
    latestMessage: DiscussionMessageRow;
    firstMessage?: DiscussionMessageRow;
}>;

/**
 * Loads every viewer-dependent summary fact for one page of discussions.
 *
 * All of it is derived, never stored: unread comes from the viewer's private
 * cursor, mentions from the sparse attention rows, and recent authors from the
 * actual message authors. Roster display reads the explicit grants and active
 * Session bindings; there is no separate summary or human-membership store.
 */
export async function loadDiscussionViewerFactsInTx(tx: Tx, params: Readonly<{
    viewerAccountId: string;
    discussions: readonly DiscussionRow[];
    tracked: boolean;
    includeFirstMessage?: boolean;
}>): Promise<ReadonlyMap<string, DiscussionViewerFacts>> {
    const facts = new Map<string, DiscussionViewerFacts>();
    if (params.discussions.length === 0) return facts;
    const discussionIds = params.discussions.map((discussion) => discussion.id);

    // Match the explicit roster's disclosure boundary. Collective grants do not
    // disclose their membership, and historic authors are not current invitees.
    const [accountGrants, participants] = await Promise.all([
        tx.discussionAccountGrant.findMany({ where: { discussionId: { in: discussionIds } },
            select: { discussionId: true, accountId: true }, orderBy: { accountId: 'asc' } }),
        tx.discussionParticipant.findMany({ where: { discussionId: { in: discussionIds }, removedAt: null, sessionId: { not: null } },
            select: { discussionId: true, sessionId: true }, orderBy: { participantSlotId: 'asc' } }),
    ]);
    const accountsByDiscussion = new Map(params.discussions.map(discussion => [discussion.id, new Set([discussion.ownerAccountId])]));
    for (const grant of accountGrants) accountsByDiscussion.get(grant.discussionId)?.add(grant.accountId);
    const sessionsByDiscussion = new Map<string, string[]>();
    for (const participant of participants) {
        if (participant.sessionId === null) continue;
        const sessions = sessionsByDiscussion.get(participant.discussionId) ?? [];
        sessions.push(participant.sessionId);
        sessionsByDiscussion.set(participant.discussionId, sessions);
    }

    // One exact-tuple lookup per page, including immutable roots only when requested.
    const summaryMessages = await tx.discussionMessage.findMany({
        where: {
            OR: params.discussions.flatMap((discussion) => [{
                discussionId: discussion.id,
                seq: discussion.messageSeq,
            }, ...(params.includeFirstMessage ? [{ discussionId: discussion.id, seq: 1 }] : [])]),
        },
        select: DISCUSSION_MESSAGE_SELECT,
    });
    const latestSeqByDiscussion = new Map(params.discussions.map(discussion => [discussion.id, discussion.messageSeq]));
    const latestByDiscussion = new Map(summaryMessages.filter(row => latestSeqByDiscussion.get(row.discussionId) === row.seq)
        .map(row => [row.discussionId, row as DiscussionMessageRow]));
    const firstByDiscussion = new Map(summaryMessages.filter(row => row.seq === 1).map(row => [row.discussionId, row as DiscussionMessageRow]));

    const authorGroups = await tx.discussionMessage.groupBy({
        by: ["discussionId", "authorAccountId"],
        where: { discussionId: { in: discussionIds }, NOT: { authorAccountId: null } },
        _max: { seq: true },
    });
    const recentAuthors = new Map<string, { accountId: string; seq: number }[]>();
    for (const group of authorGroups) {
        if (group.authorAccountId === null) continue;
        const bucket = recentAuthors.get(group.discussionId) ?? [];
        bucket.push({ accountId: group.authorAccountId, seq: group._max.seq ?? 0 });
        recentAuthors.set(group.discussionId, bucket);
    }

    const cursors = params.tracked
        ? await tx.discussionReadState.findMany({
            where: { accountId: params.viewerAccountId, discussionId: { in: discussionIds } },
            select: { discussionId: true, lastReadSeq: true },
        })
        : [];
    const cursorByDiscussion = new Map(cursors.map((row) => [row.discussionId, row.lastReadSeq]));

    const unreadCounts = await countUnreadMessagesInTx(tx, {
        viewerAccountId: params.viewerAccountId,
        cursors,
    });
    const unreadMentionCounts = await countUnreadMentionsInTx(tx, {
        viewerAccountId: params.viewerAccountId,
        cursors,
    });

    for (const discussion of params.discussions) {
        const latestMessage = latestByDiscussion.get(discussion.id);
        if (!latestMessage) continue;
        const authors = (recentAuthors.get(discussion.id) ?? [])
            .sort((left, right) => right.seq - left.seq)
            .slice(0, DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1)
            .map((author) => author.accountId);
        facts.set(discussion.id, {
            lastReadSeq: cursorByDiscussion.get(discussion.id) ?? null,
            unreadCount: unreadCounts.get(discussion.id) ?? 0,
            unreadMentionCount: unreadMentionCounts.get(discussion.id) ?? 0,
            recentAuthorAccountIds: authors,
            participantAccountIds: [...accountsByDiscussion.get(discussion.id)!],
            participantSessionIds: sessionsByDiscussion.get(discussion.id) ?? [],
            latestMessage,
            ...(params.includeFirstMessage ? { firstMessage: firstByDiscussion.get(discussion.id) } : {}),
        });
    }
    return facts;
}

export type DiscussionCursorRow = Readonly<{ discussionId: string; lastReadSeq: number }>;

/**
 * Unread excludes the viewer's own direct human posts, which are never news to
 * their author. An Agent-produced row on the viewer's execution Account is not a
 * self-send and therefore still counts.
 *
 * The predicate is written positively so an erased (`NULL`) author still counts:
 * `NOT (author = viewer AND producer IS NULL)` would evaluate to `NULL` for those
 * rows and silently drop them.
 */
export function discussionUnreadMessagesWhere(params: Readonly<{
    viewerAccountId: string;
    cursors: readonly DiscussionCursorRow[];
}>): Prisma.DiscussionMessageWhereInput {
    return { AND: [{ OR: buildBeyondCursorPredicates(params.cursors) }, {
        OR: [{ authorAccountId: { not: params.viewerAccountId } }, { authorAccountId: null },
            { producerV1: { not: getActivePrismaRuntime().DbNull } }],
    }] };
}

export async function countUnreadMessagesInTx(tx: Tx, params: Readonly<{
    viewerAccountId: string;
    cursors: readonly DiscussionCursorRow[];
}>): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    if (params.cursors.length === 0) return counts;
    const groups = await tx.discussionMessage.groupBy({
        by: ["discussionId"],
        where: discussionUnreadMessagesWhere(params),
        _count: { _all: true },
    });
    for (const group of groups) counts.set(group.discussionId, group._count._all);
    return counts;
}

/** Sparse mention rows beyond the established cursor; absence never replays history. */
export async function countUnreadMentionsInTx(tx: Tx, params: Readonly<{
    viewerAccountId: string;
    cursors: readonly DiscussionCursorRow[];
}>): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    if (params.cursors.length === 0) return counts;
    const groups = await tx.discussionMessage.groupBy({
        by: ["discussionId"],
        where: {
            AND: [
                discussionUnreadMessagesWhere(params),
                { mentions: { some: { accountId: params.viewerAccountId } } },
            ],
        },
        _count: { _all: true },
    });
    for (const group of groups) counts.set(group.discussionId, group._count._all);
    return counts;
}

function buildBeyondCursorPredicates(cursors: readonly DiscussionCursorRow[]) {
    return cursors.map((cursor) => ({
        discussionId: cursor.discussionId,
        seq: { gt: cursor.lastReadSeq },
    }));
}

export function projectDiscussionSummaryV1(params: Readonly<{
    context: DiscussionContext;
    discussion: DiscussionRow;
    viewerAccountId: string;
    includeLatestMessageContent: boolean;
    facts: DiscussionViewerFacts;
    latestMessageAccountActor: SessionMessageAccountActorV1 | null;
    latestMessageRequesterAccountActor?: SessionMessageAccountActorV1 | null;
    participantAccounts: readonly SessionMessageAccountActorV1[];
    capabilities: DiscussionCapabilitiesV1;
}>): DiscussionSummaryV1 {
    const { discussion, facts, viewerAccountId } = params;
    const latest = facts.latestMessage;
    return {
        id: discussion.id,
        ownerAccountId: discussion.ownerAccountId,
        encryptionMode: params.context.storageMode,
        anchor: discussion.anchorV1 == null ? null : DiscussionAnchorV1Schema.parse(discussion.anchorV1),
        access: params.context.access.level,
        keyReadiness: params.context.keyReadiness,
        dataEncryptionKey: params.context.dataEncryptionKey,
        creationLocalId: discussion.createdByAccountId === viewerAccountId ? discussion.creationLocalId : null,
        titleContent: readEnvelope(discussion.titleContent),
        latestMessage: {
            id: latest.id,
            localId: latest.authorAccountId === viewerAccountId ? latest.localId : null,
            seq: latest.seq,
            authorAccountId: latest.authorAccountId,
            accountActor: params.latestMessageAccountActor,
            requesterAccountActor: params.latestMessageRequesterAccountActor ?? null,
            producerV1: readProducer(latest.producerV1),
            ...(params.includeLatestMessageContent ? { content: readEnvelope(latest.content) } : {}),
            createdAt: latest.createdAt.getTime(),
        },
        messageSeq: discussion.messageSeq,
        lastReadSeq: facts.lastReadSeq,
        unreadCount: facts.unreadCount,
        unreadMentionCount: facts.unreadMentionCount,
        recentAuthorAccountIds: [...facts.recentAuthorAccountIds],
        participantAccounts: [...params.participantAccounts],
        participantSessionIds: [...facts.participantSessionIds],
        archivedAt: discussion.archivedAt ? discussion.archivedAt.getTime() : null,
        capabilities: params.capabilities,
    };
}
