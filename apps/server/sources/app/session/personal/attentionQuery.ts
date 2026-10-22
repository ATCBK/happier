import type { Prisma } from "@prisma/client";
import { SESSION_LIST_PAGE_MAX_LIMIT } from '@happier-dev/protocol/sessions/listing/query';

/**
 * One existing page-sized work batch. This is an internal memory/bind bound,
 * never a semantic ceiling: the iterator keeps advancing until the candidate
 * relation is exhausted or its caller has enough exact rows.
 */
export const SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE = SESSION_LIST_PAGE_MAX_LIMIT;

/**
 * Iterate an exact attention relation without turning a work batch into a
 * semantic result ceiling. The caller owns provider ordering/cursors; this
 * owner fixes the bounded candidate/admission lifecycle used by listing and
 * count projections.
 */
export async function* iterateBoundedSessionPersonalAttentionRows<Row, Cursor>(params: Readonly<{
    initialCursor?: Cursor;
    readCandidates: (page: Readonly<{ cursor: Cursor | undefined; take: number }>) => Promise<ReadonlyArray<Row>>;
    cursorAfter: (rows: ReadonlyArray<Row>) => Cursor;
    admitCandidates: (rows: ReadonlyArray<Row>) => Promise<ReadonlyArray<Row>>;
}>): AsyncGenerator<ReadonlyArray<Row>, void, void> {
    let cursor = params.initialCursor;
    while (true) {
        const candidates = await params.readCandidates({
            cursor,
            take: SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE,
        });
        if (candidates.length === 0) return;
        const admitted = await params.admitCandidates(candidates);
        if (admitted.length > 0) yield admitted;
        if (candidates.length < SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE) return;
        cursor = params.cursorAfter(candidates);
    }
}

/** Tracking is ownership or an active Follow; retained read rows never establish it. */
export function createSessionPersonallyTrackedWhere(accountId: string): Prisma.SessionWhereInput {
    return { OR: [{ accountId }, { accountFollows: { some: { accountId, following: true, hasPersistentFollow: true } } }] };
}

/**
 * Provider-safe superset for bounded personal-attention reads.
 *
 * Cross-model cursor comparisons cannot be represented by Prisma's
 * `SessionWhereInput`. This predicate therefore keeps only relational `EXISTS`
 * candidacy in the database. The listing scan confirms each bounded page via
 * the canonical personal projector and continues until the requested result
 * page is full or this candidate relation is exhausted.
 */
export function createSessionPersonalAttentionCandidateWhere(params: Readonly<{
    accountId: string;
    now?: Date;
}>): Prisma.SessionWhereInput {
    const now = params.now ?? new Date();
    const dueReminderWhere = {
        sessionAttentionStandings: {
            some: {
                accountId: params.accountId,
                remindAt: { lte: now },
            },
        },
    } satisfies Prisma.SessionWhereInput;
    // Candidacy only: the source-backed projector admits fulfilled exact
    // occurrences. Armed or malformed custody creates no attention.
    const onceWhere = { accountFollows: { some: { accountId: params.accountId, notifyOnce: { not: null } } } } satisfies Prisma.SessionWhereInput;

    // Independent Discussion cursors are admitted through their resource grants.
    // Tracking, due reminders and one-shot custody form the provider-safe
    // candidate superset; bounded projection applies the exact attention policy.
    return { OR: [createSessionPersonallyTrackedWhere(params.accountId), dueReminderWhere, onceWhere] };
}
