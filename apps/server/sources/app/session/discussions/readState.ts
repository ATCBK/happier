import { SESSION_DISCUSSION_NOT_TRACKED_CODE_V1, type SessionDiscussionReadCursorV1 } from "@happier-dev/protocol";

import { prismaRuntime as Prisma } from "@/storage/prisma";
import { getDbProviderFromEnv } from "@/storage/prisma";
import {
    isSessionPersonallyTrackedInTx,
    listRelevantAccountIdsForSessionBadgeRefreshInTx,
} from "@/app/session/personal/readState";
import { inTx, type Tx } from "@/storage/inTx";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { filterAccountsWithCurrentSessionReadAccessInTx, resolveSessionDiscussionContextInTx } from "./access";
import {
    markSessionDiscussionPrivateReaderChangedInTx,
    scheduleSessionDiscussionReaderBadgeRefreshInTx,
} from "./changes";
import { readSessionDiscussionRowInTx } from "./queries";
import { discussionFailure, discussionSuccess, type SessionDiscussionResult } from "./serviceTypes";

/**
 * The set of Accounts whose personal tracking of this Session has an established
 * baseline right now.
 *
 * Lane 09B owns both halves of that fact — the owner-or-active-Follow relation
 * and the durable `AccountSessionReadState` baseline it seeds on entry — so this
 * composes its two exported readers instead of reinterpreting its storage.
 * Discussion code never enrolls anybody: an Account with no Lane 09B baseline is
 * simply not tracked here either.
 */
async function listBaselinedTrackedAccountIdsInTx(tx: Tx, params: Readonly<{
    sessionId: string;
}>): Promise<readonly string[]> {
    const candidates = await listRelevantAccountIdsForSessionBadgeRefreshInTx(tx, params);
    if (candidates.length === 0) return [];
    // Set-oriented: one read for the whole candidate set instead of one read
    // per Account. Presence of the Lane 09B baseline row is the tracking fact;
    // retained inert cursors are filtered by the Follow relation already inside
    // the candidate query, so no per-Account predicate is reinterpreted here.
    const rows = await tx.accountSessionReadState.findMany({
        where: { sessionId: params.sessionId, accountId: { in: [...candidates] } },
        select: { accountId: true },
    });
    const baselined = new Set(rows.map(row => row.accountId));
    return candidates.filter(accountId => baselined.has(accountId));
}

/**
 * A new discussion starts at sequence zero for the Accounts that already track
 * this Session, so its first message can be legitimately unread for them.
 *
 * It runs inside the creating transaction, which is what keeps a concurrent
 * Lane 09B tracking entry from leaving a tracked viewer without a baseline —
 * one of the two paths always observes the other's committed row. Team or Group
 * membership alone materializes nothing.
 */
export async function initializeNewSessionDiscussionCursorsInTx(tx: Tx, params: Readonly<{
    sessionId: string;
    discussionId: string;
    authentication?: SessionAccessAuthentication;
}>): Promise<void> {
    const tracked = await listBaselinedTrackedAccountIdsInTx(tx, { sessionId: params.sessionId });
    if (tracked.length === 0) return;
    const readable = await filterAccountsWithCurrentSessionReadAccessInTx(tx, {
        sessionId: params.sessionId,
        accountIds: tracked,
        authentication: params.authentication,
    });
    const eligible = tracked.filter(accountId => readable.has(accountId));
    if (eligible.length === 0) return;
    // Set-oriented insert-ignore: one bulk statement for the whole eligible set
    // instead of one awaited upsert per Account. `update: {}` means never
    // overwrite, so insert-ignore (DO NOTHING / skipDuplicates) preserves the
    // exact create-only semantics including the concurrent tracking-entry race:
    // whichever path commits first wins, the other leaves the row untouched.
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const CHUNK = 200;
    for (let offset = 0; offset < eligible.length; offset += CHUNK) {
        const chunk = eligible.slice(offset, offset + CHUNK);
        if (provider === 'sqlite') {
            const now = new Date();
            const rows = Prisma.join(chunk.map(accountId => Prisma.sql`(${params.discussionId}, ${accountId}, 0, ${now})`));
            await tx.$executeRaw(Prisma.sql`
                INSERT INTO "SessionDiscussionReadState" ("discussionId", "accountId", "lastReadSeq", "updatedAt")
                VALUES ${rows}
                ON CONFLICT("discussionId", "accountId") DO NOTHING
            `);
        } else {
            await tx.sessionDiscussionReadState.createMany({
                data: chunk.map(accountId => ({ discussionId: params.discussionId, accountId, lastReadSeq: 0 })),
                skipDuplicates: true,
            });
        }
    }
}

/**
 * Advances every existing Discussion cursor for one already-tracked viewer to
 * the current transaction-visible ceiling.
 *
 * This is the Discussion half of an explicit whole-Session acknowledgement
 * such as scheduling a reminder. It never creates a missing cursor: enrollment
 * remains owned exclusively by Session tracking entry, and a missing cursor has
 * no tracked unread frontier to acknowledge.
 */
export async function acknowledgeCurrentSessionDiscussionFrontiersInTx(tx: Tx, params: Readonly<{
    sessionId: string;
    accountId: string;
}>): Promise<void> {
    const discussions = await tx.sessionDiscussion.findMany({
        where: { sessionId: params.sessionId },
        select: {
            id: true,
            messageSeq: true,
            readStates: {
                where: { accountId: params.accountId },
                select: { lastReadSeq: true },
            },
        },
    });
    let changed = false;
    for (const discussion of discussions) {
        const current = discussion.readStates[0];
        if (!current) continue;
        if (current.lastReadSeq >= discussion.messageSeq) continue;
        const updated = await tx.sessionDiscussionReadState.updateMany({
            where: {
                discussionId: discussion.id,
                accountId: params.accountId,
                lastReadSeq: { lt: discussion.messageSeq },
            },
            data: { lastReadSeq: discussion.messageSeq },
        });
        changed = updated.count > 0 || changed;
    }

    if (changed) {
        await markSessionDiscussionPrivateReaderChangedInTx({
            tx,
            sessionId: params.sessionId,
            accountId: params.accountId,
        });
        scheduleSessionDiscussionReaderBadgeRefreshInTx({ tx, accountId: params.accountId });
    }
}

/**
 * Advances one tracked Account's private discussion cursor.
 *
 * The cursor is monotonic and forward-only: a stale or coalesced client retry
 * reports current truth instead of regressing progress, and a sequence beyond
 * the discussion's allocator is rejected rather than clamped, because that value
 * can only come from a confused client. A missing row means Lane 09B has not
 * baselined this Account, so the request is refused without writing — merely
 * reading or posting never subscribes anybody.
 */
export async function setSessionDiscussionReadCursor(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    discussionId: string;
    lastReadSeq: number;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<SessionDiscussionResult<SessionDiscussionReadCursorV1>> {
    return await inTx(async (tx) => {
        const context = await resolveSessionDiscussionContextInTx(tx, {
            sessionId: params.sessionId,
            accountId: params.actorAccountId,
            authentication: params.authentication,
        });
        if (!context) return discussionFailure("session_discussion_not_found");
        const discussion = await readSessionDiscussionRowInTx(tx, params);
        if (!discussion) return discussionFailure("session_discussion_not_found");

        if (!await isSessionPersonallyTrackedInTx(tx, {
            accountId: params.actorAccountId,
            sessionId: params.sessionId,
            ownerAccountId: context.ownerAccountId,
        })) {
            return discussionFailure(SESSION_DISCUSSION_NOT_TRACKED_CODE_V1);
        }

        if (!Number.isSafeInteger(params.lastReadSeq)
            || params.lastReadSeq < 0
            || params.lastReadSeq > discussion.messageSeq) {
            return discussionFailure("session_discussion_read_cursor_invalid");
        }

        const existing = await tx.sessionDiscussionReadState.findUnique({
            where: { discussionId_accountId: { discussionId: discussion.id, accountId: params.actorAccountId } },
            select: { lastReadSeq: true },
        });
        if (!existing) return discussionFailure(SESSION_DISCUSSION_NOT_TRACKED_CODE_V1);

        const next = Math.max(existing.lastReadSeq, params.lastReadSeq);
        if (next === existing.lastReadSeq) {
            return discussionSuccess({ discussionId: discussion.id, lastReadSeq: existing.lastReadSeq, didChange: false });
        }

        const { count } = await tx.sessionDiscussionReadState.updateMany({
            where: { discussionId: discussion.id, accountId: params.actorAccountId, lastReadSeq: { lt: next } },
            data: { lastReadSeq: next },
        });
        if (count === 0) {
            // Another device of the same Account committed a newer frontier.
            const fresh = await tx.sessionDiscussionReadState.findUnique({
                where: { discussionId_accountId: { discussionId: discussion.id, accountId: params.actorAccountId } },
                select: { lastReadSeq: true },
            });
            return discussionSuccess({
                discussionId: discussion.id,
                lastReadSeq: fresh?.lastReadSeq ?? existing.lastReadSeq,
                didChange: false,
            });
        }

        await markSessionDiscussionPrivateReaderChangedInTx({
            tx,
            sessionId: params.sessionId,
            accountId: params.actorAccountId,
        });
        scheduleSessionDiscussionReaderBadgeRefreshInTx({ tx, accountId: params.actorAccountId });
        return discussionSuccess({ discussionId: discussion.id, lastReadSeq: next, didChange: true });
    }, { isolationLevel: "Serializable" /* Discussion read-frontier admission must remain coherent with tracking and lifecycle writers. */ });
}
