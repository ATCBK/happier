import { SESSION_DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1, type SessionDiscussionCapabilitiesV1, type SessionDiscussionMessageV1, type SessionDiscussionSummaryV1 } from '@happier-dev/protocol/sessions/discussions/models';
import { SessionDiscussionMessageContentV1Schema, SessionDiscussionProducerV1Schema, SessionDiscussionTitleV1Schema } from '@happier-dev/protocol/sessions/discussions/content';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { type SessionMessageAccountActorV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';

import type { EffectiveSessionAccess } from "@/app/session/access/sessionAccess";
import { getActivePrismaRuntime } from "@/storage/prisma";
import type { Tx } from "@/storage/inTx";

export type SessionDiscussionStoredContentFailure =
    | "session_discussion_encryption_mode_mismatch"
    | "session_discussion_invalid_content";

/**
 * Validates an opaque persisted envelope before any caller can receive it.
 *
 * The Account's Session mode is authoritative. A structurally valid envelope
 * of the opposite mode is therefore a typed consistency failure, while an
 * envelope that is not part of the strict wire union is invalid content. The
 * projector may parse only after this check has succeeded in the same
 * transaction.
 */
export function validateSessionDiscussionStoredContent(
    value: unknown,
    storageMode: "plain" | "e2ee",
    semanticKind: "title" | "message",
): SessionDiscussionStoredContentFailure | null {
    const parsed = StrictSessionStoredMessageContentEnvelopeSchema.safeParse(value);
    if (!parsed.success) return "session_discussion_invalid_content";
    const expectedKind = storageMode === "e2ee" ? "encrypted" : "plain";
    if (parsed.data.t !== expectedKind) return "session_discussion_encryption_mode_mismatch";
    if (parsed.data.t === "plain") {
        const semanticSchema = semanticKind === "title"
            ? SessionDiscussionTitleV1Schema
            : SessionDiscussionMessageContentV1Schema;
        if (!semanticSchema.safeParse(parsed.data.v).success) {
            return "session_discussion_invalid_content";
        }
    }
    return null;
}

export const SESSION_DISCUSSION_SELECT = {
    id: true,
    sessionId: true,
    creationLocalId: true,
    createdByAccountId: true,
    titleContent: true,
    messageSeq: true,
    lastMessageAt: true,
    archivedAt: true,
} as const;

export const SESSION_DISCUSSION_MESSAGE_SELECT = {
    id: true,
    discussionId: true,
    localId: true,
    seq: true,
    authorAccountId: true,
    producerV1: true,
    content: true,
    createdAt: true,
    mentions: { select: { accountId: true }, orderBy: { accountId: "asc" } },
} as const;

export type SessionDiscussionRow = Readonly<{
    id: string;
    sessionId: string;
    creationLocalId: string;
    createdByAccountId: string | null;
    titleContent: unknown;
    messageSeq: number;
    lastMessageAt: Date;
    archivedAt: Date | null;
}>;

export type SessionDiscussionMessageRow = Readonly<{
    id: string;
    discussionId: string;
    localId: string;
    seq: number;
    authorAccountId: string | null;
    producerV1: unknown;
    content: unknown;
    createdAt: Date;
    mentions: readonly Readonly<{ accountId: string }>[];
}>;

export function validateSessionDiscussionStoredMessage(
    row: Pick<SessionDiscussionMessageRow, "content" | "producerV1">,
    storageMode: "plain" | "e2ee",
    sessionId: string,
): SessionDiscussionStoredContentFailure | null {
    const contentFailure = validateSessionDiscussionStoredContent(row.content, storageMode, "message");
    if (contentFailure) return contentFailure;
    if (row.producerV1 === null || row.producerV1 === undefined) return null;
    const producer = SessionDiscussionProducerV1Schema.safeParse(row.producerV1);
    return producer.success && producer.data.sessionId === sessionId
        ? null
        : "session_discussion_invalid_content";
}

function readEnvelope(value: unknown) {
    return StrictSessionStoredMessageContentEnvelopeSchema.parse(value);
}

function readProducer(value: unknown) {
    if (value === null || value === undefined) return null;
    return SessionDiscussionProducerV1Schema.parse(value);
}

/**
 * Effective, server-evaluated discussion capabilities.
 *
 * The creator exception is a discussion-domain decision layered on current
 * `submitAgentInput`; it is not a new Session capability, a stored role, or an
 * ACL. Every input is a live access fact, so revocation immediately removes the
 * affordance.
 */
export function projectSessionDiscussionCapabilitiesV1(params: Readonly<{
    access: EffectiveSessionAccess;
    sessionArchived: boolean;
    discussionArchived: boolean;
    isCreator: boolean;
}>): SessionDiscussionCapabilitiesV1 {
    const canSubmit = params.access.capabilities.submitAgentInput && !params.sessionArchived;
    const canManage = (params.access.capabilities.manageAccess
        || (params.isCreator && params.access.capabilities.submitAgentInput))
        && !params.sessionArchived;
    return {
        postMessages: canSubmit && !params.discussionArchived,
        rename: canManage && !params.discussionArchived,
        archive: canManage && !params.discussionArchived,
        restore: params.access.capabilities.manageAccess && !params.sessionArchived && params.discussionArchived,
        askAgent: canSubmit,
        sendToSession: canSubmit,
    };
}

/** A client-chosen local request identity is projected only back to its author. */
export function projectSessionDiscussionMessageV1(
    row: SessionDiscussionMessageRow,
    viewerAccountId: string,
    accountActor: SessionMessageAccountActorV1 | null,
): SessionDiscussionMessageV1 {
    return {
        id: row.id,
        discussionId: row.discussionId,
        localId: row.authorAccountId === viewerAccountId ? row.localId : null,
        seq: row.seq,
        authorAccountId: row.authorAccountId,
        accountActor,
        producerV1: readProducer(row.producerV1),
        content: readEnvelope(row.content),
        mentionedAccountIds: row.mentions.map((mention) => mention.accountId),
        createdAt: row.createdAt.getTime(),
    };
}

export type SessionDiscussionViewerFacts = Readonly<{
    lastReadSeq: number | null;
    unreadCount: number;
    unreadMentionCount: number;
    recentAuthorAccountIds: readonly string[];
    latestMessage: SessionDiscussionMessageRow;
}>;

/**
 * Loads every viewer-dependent summary fact for one page of discussions.
 *
 * All of it is derived, never stored: unread comes from the viewer's private
 * cursor, mentions from the sparse attention rows, and recent authors from the
 * actual message authors. There is no materialized counter, participant table,
 * or per-recipient row to keep in sync.
 */
export async function loadSessionDiscussionViewerFactsInTx(tx: Tx, params: Readonly<{
    viewerAccountId: string;
    discussions: readonly SessionDiscussionRow[];
    tracked: boolean;
}>): Promise<ReadonlyMap<string, SessionDiscussionViewerFacts>> {
    const facts = new Map<string, SessionDiscussionViewerFacts>();
    if (params.discussions.length === 0) return facts;
    const discussionIds = params.discussions.map((discussion) => discussion.id);

    // One exact-tuple lookup per page, not one query per discussion: the latest
    // message is always the row whose `seq` equals the allocator's current value.
    const latestMessages = await tx.sessionDiscussionMessage.findMany({
        where: {
            OR: params.discussions.map((discussion) => ({
                discussionId: discussion.id,
                seq: discussion.messageSeq,
            })),
        },
        select: SESSION_DISCUSSION_MESSAGE_SELECT,
    });
    const latestByDiscussion = new Map(latestMessages.map((row) => [row.discussionId, row as SessionDiscussionMessageRow]));

    const authorGroups = await tx.sessionDiscussionMessage.groupBy({
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
        ? await tx.sessionDiscussionReadState.findMany({
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
            .slice(0, SESSION_DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1)
            .map((author) => author.accountId);
        facts.set(discussion.id, {
            lastReadSeq: cursorByDiscussion.get(discussion.id) ?? null,
            unreadCount: unreadCounts.get(discussion.id) ?? 0,
            unreadMentionCount: unreadMentionCounts.get(discussion.id) ?? 0,
            recentAuthorAccountIds: authors,
            latestMessage,
        });
    }
    return facts;
}

export type SessionDiscussionCursorRow = Readonly<{ discussionId: string; lastReadSeq: number }>;

/**
 * Unread excludes the viewer's own direct human posts, which are never news to
 * their author. An Agent-produced row on the viewer's execution Account is not a
 * self-send and therefore still counts.
 *
 * The predicate is written positively so an erased (`NULL`) author still counts:
 * `NOT (author = viewer AND producer IS NULL)` would evaluate to `NULL` for those
 * rows and silently drop them.
 */
export async function countUnreadMessagesInTx(tx: Tx, params: Readonly<{
    viewerAccountId: string;
    cursors: readonly SessionDiscussionCursorRow[];
}>): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    if (params.cursors.length === 0) return counts;
    const groups = await tx.sessionDiscussionMessage.groupBy({
        by: ["discussionId"],
        where: {
            AND: [
                { OR: buildBeyondCursorPredicates(params.cursors) },
                {
                    OR: [
                        { authorAccountId: { not: params.viewerAccountId } },
                        { authorAccountId: null },
                        { producerV1: { not: getActivePrismaRuntime().DbNull } },
                    ],
                },
            ],
        },
        _count: { _all: true },
    });
    for (const group of groups) counts.set(group.discussionId, group._count._all);
    return counts;
}

/** Sparse mention rows beyond the established cursor; absence never replays history. */
export async function countUnreadMentionsInTx(tx: Tx, params: Readonly<{
    viewerAccountId: string;
    cursors: readonly SessionDiscussionCursorRow[];
}>): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    if (params.cursors.length === 0) return counts;
    const groups = await tx.sessionDiscussionMessage.groupBy({
        by: ["discussionId"],
        where: {
            AND: [
                { OR: buildBeyondCursorPredicates(params.cursors) },
                { mentions: { some: { accountId: params.viewerAccountId } } },
                // The viewer's own directly authored post is never their own
                // unread attention — the same exclusion the unread message
                // count applies, so a self-mention cannot raise a badge.
                {
                    OR: [
                        { authorAccountId: { not: params.viewerAccountId } },
                        { authorAccountId: null },
                        { producerV1: { not: getActivePrismaRuntime().DbNull } },
                    ],
                },
            ],
        },
        _count: { _all: true },
    });
    for (const group of groups) counts.set(group.discussionId, group._count._all);
    return counts;
}

function buildBeyondCursorPredicates(cursors: readonly SessionDiscussionCursorRow[]) {
    return cursors.map((cursor) => ({
        discussionId: cursor.discussionId,
        seq: { gt: cursor.lastReadSeq },
    }));
}

export function projectSessionDiscussionSummaryV1(params: Readonly<{
    discussion: SessionDiscussionRow;
    viewerAccountId: string;
    facts: SessionDiscussionViewerFacts;
    latestMessageAccountActor: SessionMessageAccountActorV1 | null;
    capabilities: SessionDiscussionCapabilitiesV1;
}>): SessionDiscussionSummaryV1 {
    const { discussion, facts, viewerAccountId } = params;
    const latest = facts.latestMessage;
    return {
        id: discussion.id,
        sessionId: discussion.sessionId,
        creationLocalId: discussion.createdByAccountId === viewerAccountId ? discussion.creationLocalId : null,
        titleContent: readEnvelope(discussion.titleContent),
        latestMessage: {
            id: latest.id,
            localId: latest.authorAccountId === viewerAccountId ? latest.localId : null,
            seq: latest.seq,
            authorAccountId: latest.authorAccountId,
            accountActor: params.latestMessageAccountActor,
            producerV1: readProducer(latest.producerV1),
            createdAt: latest.createdAt.getTime(),
        },
        messageSeq: discussion.messageSeq,
        lastReadSeq: facts.lastReadSeq,
        unreadCount: facts.unreadCount,
        unreadMentionCount: facts.unreadMentionCount,
        recentAuthorAccountIds: [...facts.recentAuthorAccountIds],
        archivedAt: discussion.archivedAt ? discussion.archivedAt.getTime() : null,
        capabilities: params.capabilities,
    };
}
