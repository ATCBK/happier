import type { Prisma } from "@prisma/client";
import type { SessionDiscussionAttentionFactsV1 } from '@happier-dev/protocol/sessions/discussions/models';

import { getActivePrismaRuntime } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { filterPersonallyTrackedSessionsForAccountsInTx } from "@/app/session/personal/readState";
import { filterSessionsWithCurrentReadAccessInTx } from "./access";
import { countUnreadMentionsInTx, countUnreadMessagesInTx, type SessionDiscussionCursorRow } from "./projection";

export type SessionDiscussionAttentionByAccount =
    ReadonlyMap<string, ReadonlyMap<string, SessionDiscussionAttentionFactsV1>>;

/**
 * The one bounded discussion-attention fact loader.
 *
 * It answers "what does this Account still have to look at in these Sessions",
 * and nothing else. It does not decide personal relevance, badge eligibility, or
 * notification delivery: Lane 09B consumes these facts and owns that policy.
 *
 * Unread accrues only from an established private cursor, so an unfollowed
 * collaborator browsing a shared Session produces no personal pressure, and an
 * absent cursor never replays history as unread.
 *
 * When `sessionIds` is omitted the candidates are the Sessions where the Account
 * already holds a discussion cursor — exactly the tracked set — because there is
 * no fact to report for a Session it does not track.
 */
export async function loadSessionDiscussionAttentionForAccounts(params: Readonly<{
    accountIds: readonly string[];
    sessionIds?: readonly string[];
}>): Promise<SessionDiscussionAttentionByAccount> {
    return await inTx(async (tx) => await loadSessionDiscussionAttentionForAccountsInTx(tx, params), { isolationLevel: "Serializable" /* Discussion attention combines viewer tracking and message facts from one snapshot. */ });
}

/**
 * The transaction-local form, so a consumer already inside a transaction
 * composes one read.
 *
 * The whole candidate page is resolved set-wise: one access read, one latest
 * activity grouping, one cursor read, and two unread groupings per Account. The
 * badge count and the initial attention page both call this without a Session
 * page in hand — a per-Session loop there would issue several round trips for
 * every Session an Account tracks, on the hottest personal paths there are.
 */
export async function loadSessionDiscussionAttentionForAccountsInTx(tx: Tx, params: Readonly<{
    accountIds: readonly string[];
    sessionIds?: readonly string[];
}>): Promise<SessionDiscussionAttentionByAccount> {
    const accountIds = [...new Set(params.accountIds)];
    const result = new Map<string, Map<string, SessionDiscussionAttentionFactsV1>>();
    if (accountIds.length === 0) return result;

    const sessionIds = params.sessionIds
        ? [...new Set(params.sessionIds)]
        : await listSessionIdsWithDiscussionCursorsInTx(tx, { accountIds });
    if (sessionIds.length === 0) return result;

    const readableSessionsByAccount = await filterSessionsWithCurrentReadAccessInTx(tx, { sessionIds, accountIds });
    const trackedSessionsByAccount = await filterPersonallyTrackedSessionsForAccountsInTx(tx, { sessionIds, accountIds });
    const readableSessionIds = new Set<string>();
    for (const sessions of readableSessionsByAccount.values()) for (const sessionId of sessions) readableSessionIds.add(sessionId);
    if (readableSessionIds.size === 0) return result;

    const latestActivity = await tx.sessionDiscussion.groupBy({
        by: ["sessionId"],
        where: { sessionId: { in: [...readableSessionIds] }, archivedAt: null },
        _max: { lastMessageAt: true },
    });
    const latestActivityBySession = new Map(latestActivity.map((row) => [row.sessionId, row._max.lastMessageAt?.getTime() ?? null]));

    const cursorRows = await tx.sessionDiscussionReadState.findMany({
        where: {
            accountId: { in: accountIds },
            discussion: { sessionId: { in: [...readableSessionIds] }, archivedAt: null },
        },
        select: { accountId: true, discussionId: true, lastReadSeq: true, discussion: { select: { sessionId: true } } },
    });

    for (const accountId of accountIds) {
        const readable = readableSessionsByAccount.get(accountId) ?? new Set<string>();
        const tracked = trackedSessionsByAccount.get(accountId) ?? new Set<string>();
        const active = new Set([...readable].filter((sessionId) => tracked.has(sessionId)));
        if (active.size === 0) continue;

        const sessionByDiscussion = new Map<string, string>();
        const cursors: SessionDiscussionCursorRow[] = [];
        for (const row of cursorRows) {
            if (row.accountId !== accountId || !active.has(row.discussion.sessionId)) continue;
            sessionByDiscussion.set(row.discussionId, row.discussion.sessionId);
            cursors.push({ discussionId: row.discussionId, lastReadSeq: row.lastReadSeq });
        }
        const unread = await countUnreadMessagesInTx(tx, { viewerAccountId: accountId, cursors });
        const mentions = await countUnreadMentionsInTx(tx, { viewerAccountId: accountId, cursors });

        // A Session counts one unread conversation per conversation that still
        // has unread messages, while its mentions accumulate across them.
        const unreadConversations = new Map<string, number>();
        const unreadMentions = new Map<string, number>();
        const add = (into: Map<string, number>, discussionId: string, amount: number) => {
            const sessionId = sessionByDiscussion.get(discussionId);
            if (sessionId === undefined) return;
            into.set(sessionId, (into.get(sessionId) ?? 0) + amount);
        };
        for (const [discussionId, count] of unread) if (count > 0) add(unreadConversations, discussionId, 1);
        for (const [discussionId, count] of mentions) if (count > 0) add(unreadMentions, discussionId, count);

        const perSession = new Map<string, SessionDiscussionAttentionFactsV1>();
        for (const sessionId of active) {
            perSession.set(sessionId, {
                unreadConversationCount: unreadConversations.get(sessionId) ?? 0,
                unreadMentionCount: unreadMentions.get(sessionId) ?? 0,
                latestActivityAt: latestActivityBySession.get(sessionId) ?? null,
            });
        }
        result.set(accountId, perSession);
    }
    return result;
}

/**
 * The Sessions where at least one of these Accounts already holds a discussion
 * cursor, optionally narrowed to a caller's candidate set.
 *
 * A consumer that has a page of Sessions in hand uses this first: without a
 * cursor there is no discussion attention to report, so the bounded loader above
 * never has to visit a Session the Account does not track.
 */
export async function listSessionIdsWithDiscussionCursorsInTx(tx: Tx, params: Readonly<{
    accountIds: readonly string[];
    sessionIds?: readonly string[];
}>): Promise<string[]> {
    const accountIds = [...new Set(params.accountIds)];
    if (accountIds.length === 0) return [];
    const sessionIds = params.sessionIds ? [...new Set(params.sessionIds)] : undefined;
    if (sessionIds !== undefined && sessionIds.length === 0) return [];
    const rows = await tx.sessionDiscussion.findMany({
        where: {
            archivedAt: null,
            ...(sessionIds === undefined ? {} : { sessionId: { in: sessionIds } }),
            readStates: { some: { accountId: { in: accountIds } } },
        },
        select: { sessionId: true },
        distinct: ["sessionId"],
    });
    return rows.map((row) => row.sessionId);
}

/**
 * Human-origin discussion authorship for one Account.
 *
 * A post is human when the authenticated execution Account wrote it directly:
 * `producerV1` is the host-stamped Agent attribution, so its presence means the
 * row is Agent production recorded against that Account's runtime rather than a
 * person participating. Requested-by association carries no author column at
 * all and therefore cannot reach this predicate either.
 *
 * Archived discussions still count. Archiving hides a conversation from active
 * pressure; it does not retract the fact that somebody took part.
 */
export function createHumanDiscussionAuthorshipMessageWhere(accountId: string): Prisma.SessionDiscussionMessageWhereInput {
    return { authorAccountId: accountId, producerV1: { equals: getActivePrismaRuntime().DbNull } };
}

/** The relational `Session` arm, applied before any list page limit. */
export function createSessionsWithHumanDiscussionAuthorshipWhere(accountId: string): Prisma.SessionWhereInput {
    return { discussions: { some: { messages: { some: createHumanDiscussionAuthorshipMessageWhere(accountId) } } } };
}

/**
 * The relational `Session` arm for an existing sparse mention of this Account.
 *
 * Existence is deliberately timeless here: being named in a conversation is a
 * list-relevance fact. Whether a mention is still *actionable* is the separate
 * unread-mention fact above, which is derived from the private cursor.
 */
export function createSessionsWithDiscussionMentionWhere(accountId: string): Prisma.SessionWhereInput {
    return { discussions: { some: { messages: { some: { mentions: { some: { accountId } } } } } } };
}

export type SessionDiscussionParticipationFactsV1 = Readonly<{
    humanAuthored: boolean;
    mentioned: boolean;
}>;

/**
 * The set-oriented participation projection for a page of Sessions.
 *
 * Two bounded existence queries answer the whole page; there is no per-Session
 * follow-up and no message content is read. Callers supply Sessions they have
 * already admitted through Lane 04 access, exactly as the relational arms above
 * are composed beside the readable predicate.
 */
export async function loadSessionDiscussionParticipationForAccountInTx(tx: Tx, params: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
}>): Promise<ReadonlyMap<string, SessionDiscussionParticipationFactsV1>> {
    const sessionIds = [...new Set(params.sessionIds)];
    const facts = new Map<string, SessionDiscussionParticipationFactsV1>();
    if (sessionIds.length === 0) return facts;

    const authored = await tx.sessionDiscussionMessage.findMany({
        where: { sessionId: { in: sessionIds }, ...createHumanDiscussionAuthorshipMessageWhere(params.accountId) },
        select: { sessionId: true },
        distinct: ["sessionId"],
    });
    const mentioned = await tx.sessionDiscussionMessage.findMany({
        where: { sessionId: { in: sessionIds }, mentions: { some: { accountId: params.accountId } } },
        select: { sessionId: true },
        distinct: ["sessionId"],
    });

    const authoredIds = new Set(authored.map((row) => row.sessionId));
    const mentionedIds = new Set(mentioned.map((row) => row.sessionId));
    for (const sessionId of new Set([...authoredIds, ...mentionedIds])) {
        facts.set(sessionId, {
            humanAuthored: authoredIds.has(sessionId),
            mentioned: mentionedIds.has(sessionId),
        });
    }
    return facts;
}
