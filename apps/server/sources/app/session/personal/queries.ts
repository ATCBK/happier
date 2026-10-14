import type { Prisma } from "@prisma/client";
import type { SessionListScopeV1 } from '@happier-dev/protocol/sessions/listing/query';
import { type Tx } from "@/storage/inTx";
import {
    createSessionsWithDiscussionMentionWhere,
    createSessionsWithHumanDiscussionAuthorshipWhere,
    loadSessionDiscussionAttentionForAccountsInTx,
} from "@/app/session/discussions/attentionFacts";
import {
    loadSessionPersonalDiscussionFactsInTx,
    projectDiscussionAttentionSignals,
    QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
    type SessionPersonalDiscussionFacts,
} from "./discussionFacts";
import {
    createSessionPersonalAttentionProjectionSelectForAccounts,
    createSessionPersonalAttentionProjectionSelect,
    doesSessionViewerNeedAttention,
    type SessionPersonalAttentionProjectionRow,
} from "./projection";
import {
    createSessionPersonalAttentionCandidateWhere,
    createSessionPersonallyTrackedWhere,
    iterateBoundedSessionPersonalAttentionRows,
} from "./attentionQuery";

export {
    createSessionPersonalAttentionCandidateWhere,
    createSessionPersonallyTrackedWhere,
} from "./attentionQuery";

/** Confirm one bounded candidate page through the single attention resolver. */
export async function filterSessionPersonalAttentionRowsInTx<Row extends SessionPersonalAttentionProjectionRow>(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        rows: readonly Row[];
        qualifiedTeamIds?: ReadonlySet<string>;
        now?: number;
        /** Request/transaction-local facts to reuse when admitted rows are projected. */
        observedDiscussionFacts?: Map<string, SessionPersonalDiscussionFacts>;
    }>,
): Promise<Row[]> {
    if (params.rows.length === 0) return [];
    const discussionFacts = await loadSessionPersonalDiscussionFactsInTx(tx, {
        accountId: params.accountId,
        sessionIds: params.rows.map((row) => row.id),
    });
    const admittedRows = params.rows.filter((row) => doesSessionViewerNeedAttention({
        row,
        viewerAccountId: params.accountId,
        discussion: discussionFacts.get(row.id) ?? QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
        qualifiedTeamIds: params.qualifiedTeamIds,
        now: params.now,
    }));
    if (params.observedDiscussionFacts) {
        for (const row of admittedRows) {
            params.observedDiscussionFacts.set(
                row.id,
                discussionFacts.get(row.id) ?? QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
            );
        }
    }
    return admittedRows;
}

/**
 * One bounded candidate-query seam for list pages, continuation and exact counts.
 *
 * Prisma cannot compare a Session field with a related viewer/discussion cursor,
 * and canonical access capabilities and primary-runtime issue parsing also stay
 * at their existing typed owners. The relational predicate is therefore a
 * provider-portable Account-scoped superset. `admitRows` applies the one Protocol
 * projector to each bounded batch. Consumers must scan through rejected rows
 * before applying their output limit; exact counts exhaust the candidate domain.
 */
export function createSessionPersonalAttentionQueryInTx(tx: Tx, params: Readonly<{
    accountId: string;
    qualifiedTeamIds?: ReadonlySet<string>;
    now?: number;
    /** Retain bounded observed facts only when the same request will project rows. */
    captureObservedDiscussionFacts?: boolean;
}>) {
    const now = params.now ?? Date.now();
    const observedDiscussionFacts = params.captureObservedDiscussionFacts
        ? new Map<string, SessionPersonalDiscussionFacts>()
        : undefined;
    return {
        candidateWhere: createSessionPersonalAttentionCandidateWhere({
            accountId: params.accountId,
            now: new Date(now),
        }),
        admitRows: async <Row extends SessionPersonalAttentionProjectionRow>(rows: readonly Row[]) =>
            await filterSessionPersonalAttentionRowsInTx(tx, {
                accountId: params.accountId,
                rows,
                qualifiedTeamIds: params.qualifiedTeamIds,
                now,
                observedDiscussionFacts,
            }),
        observedDiscussionFacts,
    };
}

/** Exact count: bounded reads, but no semantic candidate ceiling. */
export async function countSessionPersonalAttentionRowsInTx(tx: Tx, params: Readonly<{
    accountId: string;
    where: Prisma.SessionWhereInput;
    qualifiedTeamIds?: ReadonlySet<string>;
    now?: number;
}>): Promise<number> {
    const query = createSessionPersonalAttentionQueryInTx(tx, params);
    let count = 0;
    for await (const rows of iterateBoundedSessionPersonalAttentionRows<SessionPersonalAttentionProjectionRow, string>({
        readCandidates: async ({ cursor, take }) => await tx.session.findMany({
            where: {
                AND: [
                    params.where,
                    query.candidateWhere,
                    ...(cursor ? [{ id: { gt: cursor } }] : []),
                ],
            },
            orderBy: { id: "asc" },
            take,
            select: createSessionPersonalAttentionProjectionSelect(params.accountId),
        }),
        cursorAfter: (rows) => rows[rows.length - 1]?.id ?? "",
        admitCandidates: query.admitRows,
    })) {
        count += rows.length;
    }
    return count;
}

/**
 * One Account's credential-qualified access restriction. Both the request-bound
 * snapshot and background refresh resolve it through the same access owner, so
 * an admission without an access predicate is not a representable state.
 */
export type SessionPersonalAttentionAccountAdmission = Readonly<{
    accountId: string;
    accessWhere: Prisma.SessionWhereInput;
    qualifiedTeamIds: ReadonlySet<string>;
}>;

const SESSION_PERSONAL_ATTENTION_ACCOUNT_BATCH_SIZE = 50;

/**
 * Exact Account-grouped attention count for badge snapshots and push refresh.
 *
 * Each bounded Account batch performs one Session-major candidate scan. The
 * canonical access projection and attention projector then admit unique
 * `(accountId, sessionId)` pairs, so overlapping ownership, Follow, direct and
 * collective access never multiply a badge. Discussion attention is loaded
 * through Lane 05's existing set-oriented fact owner for the same candidate
 * batch; no badge-local interpretation is introduced.
 */
export async function countSessionPersonalAttentionRowsForAccountsInTx(
    tx: Tx,
    params: Readonly<{
        admissions: readonly SessionPersonalAttentionAccountAdmission[];
        now?: number;
    }>,
): Promise<Map<string, number>> {
    const admissions = [...new Map(
        params.admissions.map((admission) => [admission.accountId, admission] as const),
    ).values()];
    const counts = new Map(admissions.map(({ accountId }) => [accountId, 0]));
    const now = params.now ?? Date.now();

    for (let offset = 0; offset < admissions.length; offset += SESSION_PERSONAL_ATTENTION_ACCOUNT_BATCH_SIZE) {
        const batch = admissions.slice(offset, offset + SESSION_PERSONAL_ATTENTION_ACCOUNT_BATCH_SIZE);
        const accountIds = batch.map(({ accountId }) => accountId);
        const countedSessionIds = new Map(accountIds.map((accountId) => [accountId, new Set<string>()]));

        for await (const rows of iterateBoundedSessionPersonalAttentionRows<SessionPersonalAttentionProjectionRow, string>({
            readCandidates: async ({ cursor, take }) => await tx.session.findMany({
                where: {
                    AND: [
                        { archivedAt: null },
                        {
                            OR: batch.map((admission) => ({
                                AND: [
                                    admission.accessWhere,
                                    createSessionPersonalAttentionCandidateWhere({
                                        accountId: admission.accountId,
                                        now: new Date(now),
                                    }),
                                ],
                            })),
                        },
                        ...(cursor ? [{ id: { gt: cursor } }] : []),
                    ],
                },
                orderBy: { id: "asc" },
                take,
                select: createSessionPersonalAttentionProjectionSelectForAccounts(accountIds),
            }),
            cursorAfter: (rows) => rows[rows.length - 1]?.id ?? "",
            admitCandidates: async (rows) => {
                const discussionByAccount = await loadSessionDiscussionAttentionForAccountsInTx(tx, {
                    accountIds,
                    sessionIds: rows.map((row) => row.id),
                });
                for (const row of rows) {
                    for (const admission of batch) {
                        const discussionSignals = projectDiscussionAttentionSignals(
                            discussionByAccount.get(admission.accountId)?.get(row.id),
                        );
                        if (!doesSessionViewerNeedAttention({
                            row,
                            viewerAccountId: admission.accountId,
                            discussion: {
                                ...discussionSignals,
                                authored: false,
                                mentioned: false,
                            },
                            qualifiedTeamIds: admission.qualifiedTeamIds,
                            now,
                        })) continue;
                        countedSessionIds.get(admission.accountId)?.add(row.id);
                    }
                }
                // Counting is accumulated by unique Account/Session identity;
                // the iterator only needs a nonempty marker for this batch.
                return rows;
            },
        })) {
            // The iterator owns bounded continuation; accumulation happens in
            // `admitCandidates` so one Session may contribute to several Accounts.
            void rows;
        }

        for (const accountId of accountIds) {
            counts.set(accountId, countedSessionIds.get(accountId)?.size ?? 0);
        }
    }

    return counts;
}

/** Active Follow only; an explicit suppression row is never a Following member. */
function createActiveFollowWhere(accountId: string): Prisma.SessionWhereInput {
    return { accountFollows: { some: { accountId, following: true,
        notificationLevel: { in: ["none", "important", "all_messages"] } } } };
}

/**
 * The participation arms of `involving_me`: ownership, responsibility, a genuine
 * direct share, and authenticated human authorship of either the Session
 * transcript (Lane 04's derived `SessionMessage.authorAccountId` projection) or
 * a discussion (Lane 05's human-origin predicate).
 *
 * Both authorship arms are existential and human-origin only. An Agent row
 * carrying its execution Account, and a requested-by association that carries no
 * author at all, are production facts rather than participation.
 *
 * A mention is deliberately absent: being named is My work relevance, not
 * participation (§4.3).
 */
function createSessionParticipationWhere(accountId: string): readonly Prisma.SessionWhereInput[] {
    return [
        { accountId },
        { responsibleAccountId: accountId },
        { shares: { some: { sharedWithUserId: accountId } } },
        { messages: { some: { authorAccountId: accountId } } },
        createSessionsWithHumanDiscussionAuthorshipWhere(accountId),
    ];
}

/** Lane 07 composes these personal relations with the independent access predicate. */
export function createSessionListScopeWhere(params: Readonly<{
    accountId: string;
    scope: SessionListScopeV1;
}>): Prisma.SessionWhereInput {
    const { accountId, scope } = params;
    if (scope === "all_accessible") return {};
    if (scope === "assigned_to_me") return { responsibleAccountId: accountId };
    if (scope === "following") return createActiveFollowWhere(accountId);
    if (scope === "involving_me") return { OR: [...createSessionParticipationWhere(accountId)] };
    // My work is any personal relevance reason: participation plus the personal
    // interest and organization facts. An explicit attention standing may add a
    // row; a negative one only removes its own contribution, and neither changes
    // tracking (L09B-I8).
    return { OR: [
        ...createSessionParticipationWhere(accountId),
        createSessionsWithDiscussionMentionWhere(accountId),
        createActiveFollowWhere(accountId),
        { sessionPins: { some: { accountId } } },
        {
            sessionAttentionStandings: {
                some: {
                    accountId,
                    OR: [
                        { standing: true },
                        { remindAt: { not: null } },
                    ],
                },
            },
        },
    ] };
}
