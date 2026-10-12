import {
    SESSION_DISCUSSION_DEFAULT_PAGE_SIZE_V1,
    SESSION_DISCUSSION_MAX_PAGE_SIZE_V1,
    type SessionDiscussionDetailsResponseV1,
    type SessionDiscussionListResponseV1,
    type SessionDiscussionMessagesResponseV1,
    type SessionDiscussionSummaryV1,
} from "@happier-dev/protocol";

import { inTx, type Tx } from "@/storage/inTx";
import { projectAuthenticatedAccountActorsById } from "@/app/session/messages/projectSessionMessageAccountActors";
import { isSessionPersonallyTrackedInTx } from "@/app/session/personal/readState";
import { resolveSessionDiscussionContextInTx, type SessionDiscussionSessionContext } from "./access";
import {
    buildSessionDiscussionListCursorPredicate,
    decodeSessionDiscussionListCursorV1,
    encodeSessionDiscussionListCursorV1,
} from "./pagination";
import {
    SESSION_DISCUSSION_MESSAGE_SELECT,
    SESSION_DISCUSSION_SELECT,
    loadSessionDiscussionViewerFactsInTx,
    projectSessionDiscussionCapabilitiesV1,
    projectSessionDiscussionMessageV1,
    projectSessionDiscussionSummaryV1,
    validateSessionDiscussionStoredContent,
    validateSessionDiscussionStoredMessage,
    type SessionDiscussionMessageRow,
    type SessionDiscussionRow,
} from "./projection";
import { discussionFailure, discussionSuccess, type SessionDiscussionResult } from "./serviceTypes";

function boundedPageSize(limit: number | undefined): number {
    if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1) {
        return SESSION_DISCUSSION_DEFAULT_PAGE_SIZE_V1;
    }
    return Math.min(limit, SESSION_DISCUSSION_MAX_PAGE_SIZE_V1);
}

/**
 * Projects one page of discussions for one viewer.
 *
 * Shared with the mutation owner so a create/rename/archive response and a later
 * list read can never disagree about capabilities, unread, or local-request
 * identity projection.
 */
export async function projectSessionDiscussionsForViewerInTx(tx: Tx, params: Readonly<{
    context: SessionDiscussionSessionContext;
    viewerAccountId: string;
    discussions: readonly SessionDiscussionRow[];
}>): Promise<SessionDiscussionResult<SessionDiscussionSummaryV1[]>> {
    const tracked = await isSessionPersonallyTrackedInTx(tx, {
        accountId: params.viewerAccountId,
        sessionId: params.context.sessionId,
        ownerAccountId: params.context.ownerAccountId,
    });
    const facts = await loadSessionDiscussionViewerFactsInTx(tx, {
        viewerAccountId: params.viewerAccountId,
        discussions: params.discussions,
        tracked,
    });
    const validatedFacts = [];
    for (const discussion of params.discussions) {
        const discussionFacts = facts.get(discussion.id);
        // A discussion is committed atomically with its first message. A missing
        // latest row or an invalid latest envelope/producer is corrupted stored
        // content, never an empty conversation or a human-authored fallback.
        if (!discussionFacts) return discussionFailure("session_discussion_invalid_content");
        const validationFailure = validateSessionDiscussionStoredMessage(
            discussionFacts.latestMessage,
            params.context.storageMode,
            params.context.sessionId,
        );
        if (validationFailure) return discussionFailure(validationFailure);
        validatedFacts.push(discussionFacts);
    }
    const latestActors = await projectAuthenticatedAccountActorsById(
        tx,
        validatedFacts.map((discussionFacts) => discussionFacts.latestMessage.authorAccountId),
    );
    const summaries: SessionDiscussionSummaryV1[] = [];
    for (const [index, discussion] of params.discussions.entries()) {
        const discussionFacts = validatedFacts[index]!;
        summaries.push(projectSessionDiscussionSummaryV1({
            discussion,
            viewerAccountId: params.viewerAccountId,
            facts: discussionFacts,
            latestMessageAccountActor: latestActors[index] ?? null,
            capabilities: projectSessionDiscussionCapabilitiesV1({
                access: params.context.access,
                sessionArchived: params.context.sessionArchived,
                discussionArchived: discussion.archivedAt !== null,
                isCreator: discussion.createdByAccountId === params.viewerAccountId,
            }),
        }));
    }
    return discussionSuccess(summaries);
}

export async function projectSessionDiscussionForViewerInTx(tx: Tx, params: Readonly<{
    context: SessionDiscussionSessionContext;
    viewerAccountId: string;
    discussion: SessionDiscussionRow;
}>): Promise<SessionDiscussionResult<SessionDiscussionSummaryV1>> {
    const projected = await projectSessionDiscussionsForViewerInTx(tx, {
        context: params.context,
        viewerAccountId: params.viewerAccountId,
        discussions: [params.discussion],
    });
    if (!projected.ok) return projected;
    const summary = projected.value[0];
    return summary
        ? discussionSuccess(summary)
        : discussionFailure("session_discussion_invalid_content");
}

export async function readSessionDiscussionRowInTx(tx: Tx, params: Readonly<{
    sessionId: string;
    discussionId: string;
}>): Promise<SessionDiscussionRow | null> {
    const row = await tx.sessionDiscussion.findFirst({
        where: { id: params.discussionId, sessionId: params.sessionId },
        select: SESSION_DISCUSSION_SELECT,
    });
    return row ?? null;
}

export async function listSessionDiscussions(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    state?: "active" | "archived";
    cursor?: string;
    limit?: number;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<SessionDiscussionResult<SessionDiscussionListResponseV1>> {
    return await inTx(async (tx) => {
        const context = await resolveSessionDiscussionContextInTx(tx, {
            sessionId: params.sessionId,
            accountId: params.actorAccountId,
            authentication: params.authentication,
        });
        if (!context) return discussionFailure("session_discussion_read_denied");

        const decodedCursor = params.cursor === undefined
            ? null
            : decodeSessionDiscussionListCursorV1(params.cursor);
        if (params.cursor !== undefined && decodedCursor === null) {
            return discussionFailure("session_discussion_invalid_content");
        }

        const take = boundedPageSize(params.limit);
        const rows = await tx.sessionDiscussion.findMany({
            where: {
                sessionId: params.sessionId,
                archivedAt: params.state === "archived" ? { not: null } : null,
                ...(decodedCursor ? buildSessionDiscussionListCursorPredicate(decodedCursor) : {}),
            },
            select: SESSION_DISCUSSION_SELECT,
            orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
            take: take + 1,
        });

        const page = rows.slice(0, take);
        for (const discussion of page) {
            const validationFailure = validateSessionDiscussionStoredContent(
                discussion.titleContent,
                context.storageMode,
                "title",
            );
            if (validationFailure) return discussionFailure(validationFailure);
        }
        const last = page.length === take ? page[page.length - 1] : undefined;
        const nextCursor = rows.length > take && last
            ? encodeSessionDiscussionListCursorV1({ v: 1, at: last.lastMessageAt.getTime(), id: last.id })
            : null;

        const projected = await projectSessionDiscussionsForViewerInTx(tx, {
            context,
            viewerAccountId: params.actorAccountId,
            discussions: page,
        });
        if (!projected.ok) return projected;
        return discussionSuccess({
            discussions: projected.value,
            nextCursor,
        });
    }, { isolationLevel: "Serializable" /* Discussion content, latest-message facts and viewer admission require a coherent snapshot. */ });
}

export async function getSessionDiscussion(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    discussionId: string;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<SessionDiscussionResult<SessionDiscussionDetailsResponseV1>> {
    return await inTx(async (tx) => {
        const context = await resolveSessionDiscussionContextInTx(tx, {
            sessionId: params.sessionId,
            accountId: params.actorAccountId,
            authentication: params.authentication,
        });
        // A named discussion is never confirmed to an Account that cannot read
        // the Session; absence and denial are one indistinguishable result.
        if (!context) return discussionFailure("session_discussion_not_found");
        const discussion = await readSessionDiscussionRowInTx(tx, params);
        if (!discussion) return discussionFailure("session_discussion_not_found");
        const validationFailure = validateSessionDiscussionStoredContent(
            discussion.titleContent,
            context.storageMode,
            "title",
        );
        if (validationFailure) return discussionFailure(validationFailure);
        const projected = await projectSessionDiscussionForViewerInTx(tx, {
            context,
            viewerAccountId: params.actorAccountId,
            discussion,
        });
        if (!projected.ok) return projected;
        return discussionSuccess({ discussion: projected.value });
    }, { isolationLevel: "Serializable" /* Discussion content, latest-message facts and viewer admission require a coherent snapshot. */ });
}

/**
 * Keyset message paging over the discussion-local sequence.
 *
 * `beforeSeq` walks older history, `afterSeq` performs a bounded tail catch-up
 * after a wake, and neither needs an opaque cursor because `seq` is already the
 * exact stable boundary. Results are always ascending.
 */
export async function readSessionDiscussionMessages(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    discussionId: string;
    beforeSeq?: number;
    afterSeq?: number;
    limit?: number;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<SessionDiscussionResult<SessionDiscussionMessagesResponseV1>> {
    if (params.beforeSeq !== undefined && params.afterSeq !== undefined) {
        return discussionFailure("session_discussion_invalid_content");
    }
    return await inTx(async (tx) => {
        const context = await resolveSessionDiscussionContextInTx(tx, {
            sessionId: params.sessionId,
            accountId: params.actorAccountId,
            authentication: params.authentication,
        });
        if (!context) return discussionFailure("session_discussion_not_found");
        const discussion = await readSessionDiscussionRowInTx(tx, params);
        if (!discussion) return discussionFailure("session_discussion_not_found");

        const take = boundedPageSize(params.limit);
        const ascending = params.afterSeq !== undefined;
        const rows = await tx.sessionDiscussionMessage.findMany({
            where: {
                discussionId: discussion.id,
                ...(params.beforeSeq !== undefined ? { seq: { lt: params.beforeSeq } } : {}),
                ...(params.afterSeq !== undefined ? { seq: { gt: params.afterSeq } } : {}),
            },
            select: SESSION_DISCUSSION_MESSAGE_SELECT,
            orderBy: { seq: ascending ? "asc" : "desc" },
            take,
        });
        const ordered = (ascending ? rows : [...rows].reverse()) as SessionDiscussionMessageRow[];
        for (const message of ordered) {
            const validationFailure = validateSessionDiscussionStoredMessage(
                message,
                context.storageMode,
                params.sessionId,
            );
            if (validationFailure) return discussionFailure(validationFailure);
        }
        const actors = await projectAuthenticatedAccountActorsById(
            tx,
            ordered.map((row) => row.authorAccountId),
        );

        const oldest = ordered[0];
        const hasMoreOlder = oldest === undefined
            ? false
            : (await tx.sessionDiscussionMessage.findFirst({
                where: { discussionId: discussion.id, seq: { lt: oldest.seq } },
                select: { id: true },
            })) !== null;

        return discussionSuccess({
            messages: ordered.map((row, index) => projectSessionDiscussionMessageV1(
                row,
                params.actorAccountId,
                actors[index] ?? null,
            )),
            hasMoreOlder,
            messageSeq: discussion.messageSeq,
        });
    }, { isolationLevel: "Serializable" /* Discussion content, latest-message facts and viewer admission require a coherent snapshot. */ });
}
