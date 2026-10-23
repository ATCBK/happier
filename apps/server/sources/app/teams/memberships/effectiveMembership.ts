import type { Tx } from "@/storage/inTx";
import {
    AccountStatus,
    TeamMembershipStatus,
    type SessionHistoryAccess,
    type TeamRole,
} from "@/storage/enums.generated";
import { sessionHistoryAccessOf } from "./sessionHistory";

/**
 * One resolved Team-membership lifetime, as seen inside the deciding transaction.
 *
 * `effective` is Lane 01's single structural membership predicate. It is a
 * structural fact only: it does not claim the request satisfies a configured Team
 * authentication requirement, and it never decides Session access. Consumers read
 * this projection instead of rebuilding it from role strings, external source
 * state, or client data.
 */
export type TeamMembershipLifetimeContext = Readonly<{
    teamMembershipId: string;
    teamId: string;
    accountId: string;
    role: TeamRole;
    status: TeamMembershipStatus;
    /**
     * The server-owned access input. Lane 04 alone compares it with a grant's
     * immutable `effectiveAt`; nothing here interprets it.
     */
    sessionAccessStartsAt: Date | null;
    historyAccess: SessionHistoryAccess;
    effective: boolean;
}>;

export type TeamMembershipContextError =
    | "team_membership_not_found"
    | "team_membership_account_changed";

export type TeamMembershipContextResolution =
    | Readonly<{ ok: true; membership: TeamMembershipLifetimeContext }>
    | Readonly<{ ok: false; error: TeamMembershipContextError }>;

/**
 * Current effective Team membership: an active Account, an active membership, and
 * a Team that is not archived. Archival makes Team-derived access ineffective while
 * every row is retained for restoration.
 */
export const EFFECTIVE_TEAM_MEMBERSHIP_WHERE = {
    status: TeamMembershipStatus.active,
    account: { status: AccountStatus.active },
    team: { archivedAt: null },
} as const;

export function isEffectiveTeamMembership(
    input: Readonly<{
        accountStatus: AccountStatus;
        membershipStatus: TeamMembershipStatus;
        teamArchivedAt: Date | null;
    }>,
): boolean {
    return input.accountStatus === AccountStatus.active
        && input.membershipStatus === TeamMembershipStatus.active
        && input.teamArchivedAt === null;
}

/**
 * Resolve one immutable membership lifetime by id inside the caller's transaction.
 *
 * Callers that persisted a membership id earlier — historical key preparation is the
 * current one — must also state which Account they believe owns that lifetime.
 * Provider Account replacement deliberately moves `accountId` while preserving the
 * lifetime, so an id alone would silently retarget historical work at whoever holds
 * the membership now. A changed Account is therefore rejected rather than served.
 *
 * A membership id that belongs to another Team resolves as absent: a caller holding
 * an id must not learn that it exists somewhere else.
 */
export async function resolveTeamMembershipContextInTx(
    tx: Tx,
    params: Readonly<{
        teamId: string;
        teamMembershipId: string;
        expectedAccountId: string;
    }>,
): Promise<TeamMembershipContextResolution> {
    const membership = await tx.teamMembership.findUnique({
        where: { id: params.teamMembershipId },
        select: {
            id: true,
            teamId: true,
            accountId: true,
            role: true,
            status: true,
            sessionAccessStartsAt: true,
            account: { select: { status: true } },
            team: { select: { archivedAt: true } },
        },
    });

    if (!membership || membership.teamId !== params.teamId) {
        return { ok: false, error: "team_membership_not_found" };
    }
    if (membership.accountId !== params.expectedAccountId) {
        return { ok: false, error: "team_membership_account_changed" };
    }

    return {
        ok: true,
        membership: {
            teamMembershipId: membership.id,
            teamId: membership.teamId,
            accountId: membership.accountId,
            role: membership.role,
            status: membership.status,
            sessionAccessStartsAt: membership.sessionAccessStartsAt,
            historyAccess: sessionHistoryAccessOf(membership.sessionAccessStartsAt),
            effective: isEffectiveTeamMembership({
                accountStatus: membership.account.status,
                membershipStatus: membership.status,
                teamArchivedAt: membership.team.archivedAt,
            }),
        },
    };
}
