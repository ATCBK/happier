import type { TeamMembershipManagementV1, TeamMembershipV1 } from "@happier-dev/protocol/teams";

import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
} from "@/app/account/profile/accountDisplayProfile";
import type { AccountStatus, TeamMembershipStatus, TeamRole } from "@/storage/enums.generated";
import { sessionHistoryAccessOf } from "./sessionHistory";
import {
    resolveTeamMemberTargetCapabilities,
    type TeamMemberActorFacts,
} from "./capabilities";

/**
 * The one select behind every member projection.
 *
 * The provisioned identity is joined for exactly three facts: whether a source
 * owns this lifetime, what to call that source on screen, and which source to
 * open from member detail. No external user id, subject, email, cursor, or
 * reconciliation marker is selected — those are Lane 03 evidence and must not
 * reach a roster row.
 */
export const TEAM_MEMBERSHIP_ROW_SELECT = {
    id: true,
    teamId: true,
    accountId: true,
    role: true,
    status: true,
    sessionAccessStartsAt: true,
    createdAt: true,
    account: { select: { ...ACCOUNT_DISPLAY_PROFILE_SELECT, status: true } },
    provisionedIdentity: {
        select: { source: { select: { id: true, displayName: true } } },
    },
    identityConnectionManagement: {
        select: {
            identityConnection: {
                select: { id: true, providerInstance: { select: { displayName: true } } },
            },
        },
    },
} as const;

export type TeamMembershipRow = Readonly<{
    id: string;
    teamId: string;
    accountId: string;
    role: TeamRole;
    status: TeamMembershipStatus;
    sessionAccessStartsAt: Date | null;
    createdAt: Date;
    account: Readonly<{
        id: string;
        name: string | null;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        avatar: unknown;
        status: AccountStatus;
    }>;
    provisionedIdentity: Readonly<{ source: Readonly<{ id: string; displayName: string }> }> | null;
    identityConnectionManagement: Readonly<{
        identityConnection: Readonly<{ id: string; providerInstance: Readonly<{ displayName: string }> }>;
    }> | null;
}>;

/**
 * Who owns this lifetime, as a roster may safely say it.
 *
 * Both external owner kinds project only from their persisted membership-lifetime
 * binding. A connection id seen during authentication is never enough to label
 * an arbitrary Team member as externally managed.
 */
export function projectTeamMembershipManagementV1(row: TeamMembershipRow): TeamMembershipManagementV1 {
    if (row.provisionedIdentity) {
        return {
            kind: "directory_source",
            directorySourceId: row.provisionedIdentity.source.id,
            label: row.provisionedIdentity.source.displayName,
        };
    }
    if (row.identityConnectionManagement) {
        return {
            kind: "identity_connection",
            identityConnectionId: row.identityConnectionManagement.identityConnection.id,
            label: row.identityConnectionManagement.identityConnection.providerInstance.displayName,
        };
    }
    return { kind: "native" };
}

export function isExternallyManagedMembership(row: TeamMembershipRow): boolean {
    return row.provisionedIdentity !== null || row.identityConnectionManagement !== null;
}

/**
 * Project one roster row for one viewer.
 *
 * `historyAccess` is derived from the stored cutoff by the one horizon owner, so
 * the raw timestamp never leaves the server and no consumer can start comparing
 * it with a grant's `effectiveAt`.
 */
export function projectTeamMembershipV1(input: Readonly<{
    row: TeamMembershipRow;
    actor: TeamMemberActorFacts;
    teamArchivedAt: Date | null;
    activeOwnerCount: number;
    /**
     * The Accounts on this page that a directory source of this Team could take
     * over, resolved once by the caller's own query rather than per row.
     */
    managementTransferTargets: ReadonlySet<string>;
}>): TeamMembershipV1 {
    return {
        v: 1,
        id: input.row.id,
        teamId: input.row.teamId,
        accountId: input.row.accountId,
        account: projectAccountDisplayProfileV1(input.row.account),
        role: input.row.role,
        status: input.row.status,
        historyAccess: sessionHistoryAccessOf(input.row.sessionAccessStartsAt),
        management: projectTeamMembershipManagementV1(input.row),
        capabilities: resolveTeamMemberTargetCapabilities({
            actor: input.actor,
            target: {
                accountId: input.row.accountId,
                role: input.row.role,
                status: input.row.status,
                accountStatus: input.row.account.status,
                managedExternally: isExternallyManagedMembership(input.row),
                managementTransferTargetAvailable:
                    input.managementTransferTargets.has(input.row.accountId),
            },
            teamArchivedAt: input.teamArchivedAt,
            activeOwnerCount: input.activeOwnerCount,
        }),
        joinedAt: input.row.createdAt.getTime(),
    };
}
