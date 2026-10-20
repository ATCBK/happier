import { inReadSnapshot, type Tx } from "@/storage/inTx";
import {
    buildCurrentSessionAccessMembershipWhere,
    isGrantAfterMembershipHorizon,
    isSessionCollaborationEnabled,
} from "./sessionAccess";
import { buildSessionReadableAccountWhereInTx } from "./sessionAccessWhere";
import {
    isSessionTranscriptShareable,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";

/**
 * Resolve complete current structural recipients for several Sessions in one
 * transaction snapshot. The Session-id map is the batch form of the point
 * resolver below; it does not expose grant/membership topology to callers.
 */
export async function resolveCurrentSessionRecipientAccountIdsBySessionInTx(
    tx: Tx,
    params: Readonly<{
        sessionIds: readonly string[];
        /** Publication fences also cover grants that the pending write can expose. */
        includeUnpublishedGrants?: boolean;
        /** Account reactivation must wait behind a fence for its retained grant. */
        includeInactiveAccounts?: boolean;
    }>,
): Promise<ReadonlyMap<string, readonly string[]>> {
    const sessionIds = [...new Set(params.sessionIds.filter(Boolean))];
    const recipientsBySessionId = new Map<string, Set<string>>(
        sessionIds.map((sessionId) => [sessionId, new Set<string>()]),
    );
    if (sessionIds.length === 0) return new Map();

    const sessions = await tx.session.findMany({
        where: { id: { in: sessionIds } },
        select: {
            id: true,
            ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
            account: { select: { status: true } },
        },
    });
    const shareableSessionIds: string[] = [];
    for (const session of sessions) {
        if (params.includeInactiveAccounts || session.account.status === "active") {
            recipientsBySessionId.get(session.id)?.add(session.accountId);
        }
        if (params.includeUnpublishedGrants || isSessionTranscriptShareable(session)) shareableSessionIds.push(session.id);
    }

    if (shareableSessionIds.length > 0) {
        const shares = await tx.sessionShare.findMany({
            where: {
                sessionId: { in: shareableSessionIds },
                ...(params.includeInactiveAccounts ? {} : { sharedWithUser: { status: "active" as const } }),
            },
            select: { sessionId: true, sharedWithUserId: true },
        });
        for (const share of shares) {
            recipientsBySessionId.get(share.sessionId)?.add(share.sharedWithUserId);
        }
    }

    const membershipWhere = (includeGuests: boolean) => {
        const where = buildCurrentSessionAccessMembershipWhere(includeGuests);
        if (params.includeInactiveAccounts) delete where.account;
        return where;
    };
    if (shareableSessionIds.length > 0 && isSessionCollaborationEnabled()) {
        const teamGrants = await tx.sessionTeamGrant.findMany({
            where: {
                sessionId: { in: shareableSessionIds },
                team: { archivedAt: null },
            },
            select: {
                sessionId: true,
                effectiveAt: true,
                team: {
                    select: {
                        memberships: {
                            where: {
                                ...membershipWhere(false),
                            },
                            select: { accountId: true, sessionAccessStartsAt: true },
                        },
                    },
                },
            },
        });
        for (const grant of teamGrants) {
            const recipients = recipientsBySessionId.get(grant.sessionId);
            for (const membership of grant.team.memberships) {
                if (isGrantAfterMembershipHorizon(grant.effectiveAt, membership.sessionAccessStartsAt)) {
                    recipients?.add(membership.accountId);
                }
            }
        }

        const groupGrants = await tx.sessionGroupGrant.findMany({
            where: {
                sessionId: { in: shareableSessionIds },
                teamGroup: { archivedAt: null, team: { archivedAt: null } },
            },
            select: {
                sessionId: true,
                effectiveAt: true,
                teamGroup: {
                    select: {
                        memberships: {
                            where: {
                                teamMembership: {
                                    ...membershipWhere(true),
                                },
                            },
                            select: {
                                sessionAccessStartsAt: true,
                                teamMembership: { select: { accountId: true } },
                            },
                        },
                    },
                },
            },
        });
        for (const grant of groupGrants) {
            const recipients = recipientsBySessionId.get(grant.sessionId);
            for (const membership of grant.teamGroup.memberships) {
                if (isGrantAfterMembershipHorizon(grant.effectiveAt, membership.sessionAccessStartsAt)) {
                    recipients?.add(membership.teamMembership.accountId);
                }
            }
        }
    }

    const result = new Map<string, readonly string[]>();
    for (const [sessionId, accountIds] of recipientsBySessionId) {
        result.set(sessionId, [...accountIds].sort());
    }
    return result;
}

/** Access recipients are synchronization targets, never notification interest. */
export async function resolveCurrentSessionRecipientAccountIdsInTx(
    tx: Tx,
    params: Readonly<{ sessionId: string }>,
): Promise<string[]> {
    if (!params.sessionId) return [];
    const recipients = await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, {
        sessionIds: [params.sessionId],
    });
    return [...(recipients.get(params.sessionId) ?? [])];
}

/** The read-only fanout wrapper keeps the complete census in one current transaction. */
export async function resolveCurrentSessionRecipientAccountIds(
    params: Readonly<{ sessionId: string }>,
): Promise<string[]> {
    return inReadSnapshot(tx => resolveCurrentSessionRecipientAccountIdsInTx(tx, params));
}

/**
 * Resolve the complete current structural audience, including grants whose
 * transcript is not yet publishable. Deletion/access-ended hints use it to
 * retire every retained row, and policy checks use it instead of interpreting
 * stored grant rows as if archived or expired sources were still effective.
 */
export async function resolveSessionGrantedAccountIdsInTx(
    tx: Tx,
    params: Readonly<{ sessionId: string }>,
): Promise<string[]> {
    if (!params.sessionId) return [];
    const where = await buildSessionReadableAccountWhereInTx({
        tx,
        sessionId: params.sessionId,
        includeUnpublishedGrants: true,
    });
    const rows = await tx.account.findMany({ where, select: { id: true }, orderBy: { id: "asc" } });
    return rows.map(row => row.id);
}
