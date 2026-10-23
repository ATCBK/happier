import type { Tx } from "@/storage/inTx";
import { resolveDbSqlDialect } from "@/config/databaseProvider";
import { getDbProviderFromEnv, prismaRuntime } from "@/storage/prisma";
import { portableQueryChunks } from "@/storage/portableQueryChunks";

/**
 * The one Team-ownership question Account erasure must ask.
 *
 * Erasure is not a Team mutation and must not become a second Team-membership
 * workflow: this child supplies only the predicate, and the existing erasure
 * owner composes it before destructive blob work and again at final deletion.
 */
export type TeamOwnershipErasureDecision =
    | Readonly<{ status: "ok" }>
    | Readonly<{ status: "rejected"; code: "team_owner_transfer_required"; teamIds: readonly string[] }>;

/**
 * Evaluates the Team-ownership erasure precondition for a bounded Account set.
 * The People projection uses this batch form so a page does not issue one
 * ownership query family per row; the single-Account erasure guard below
 * delegates to the same result and therefore cannot drift from presentation.
 */
export async function readTeamOwnershipErasureDecisionsInTx(
    tx: Tx,
    input: Readonly<{ accountIds: readonly string[] }>,
): Promise<ReadonlyMap<string, TeamOwnershipErasureDecision>> {
    const accountIds = [...new Set(input.accountIds)];
    const allowed = (): TeamOwnershipErasureDecision => ({ status: "ok" });
    const decisions = new Map<string, TeamOwnershipErasureDecision>(
        accountIds.map((accountId): [string, TeamOwnershipErasureDecision] => [accountId, allowed()]),
    );
    if (accountIds.length === 0) return decisions;

    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, "postgres"));
    // Identifiers are fixed here; only the requested Account ids are bound data.
    const identifier = (name: string) => prismaRuntime.raw(dialect === "mysql" ? `\`${name}\`` : `"${name}"`);
    // Ownership survives retirement/suspension for erasure retries. The joined
    // members are only *other* current members, never the target's lifecycle.
    // Aggregate at the database: return blocked identities, not a Team or
    // membership inventory, and avoid repeating a correlated scan per Team.
    const blockedOwnerships = (await Promise.all(portableQueryChunks({ values: accountIds, bindingsPerValue: 1 }).map(ids =>
        tx.$queryRaw<Array<{ accountId: string; teamId: string }>>(prismaRuntime.sql`
            SELECT ownership.${identifier("accountId")} AS ${identifier("accountId")},
                ownership.${identifier("teamId")} AS ${identifier("teamId")}
            FROM ${identifier("TeamMembership")} AS ownership
            JOIN ${identifier("Team")} AS ownedTeam ON ownedTeam.${identifier("id")} = ownership.${identifier("teamId")}
            JOIN ${identifier("TeamMembership")} AS otherMembership
                ON otherMembership.${identifier("teamId")} = ownership.${identifier("teamId")}
                AND otherMembership.${identifier("accountId")} <> ownership.${identifier("accountId")}
                AND otherMembership.${identifier("status")} = 'active'
            JOIN ${identifier("Account")} AS otherAccount
                ON otherAccount.${identifier("id")} = otherMembership.${identifier("accountId")}
                AND otherAccount.${identifier("status")} = 'active'
            WHERE ownership.${identifier("accountId")} IN (${prismaRuntime.join([...ids])})
                AND ownership.${identifier("role")} = 'owner'
                AND ownedTeam.${identifier("archivedAt")} IS NULL
            GROUP BY ownership.${identifier("accountId")}, ownership.${identifier("teamId")}
            HAVING COUNT(CASE WHEN otherMembership.${identifier("role")} = 'owner' THEN 1 END) = 0
        `),
    ))).flat();
    const blockedByAccountId = new Map<string, string[]>();
    for (const ownership of blockedOwnerships) {
        const blocked = blockedByAccountId.get(ownership.accountId) ?? [];
        blocked.push(ownership.teamId);
        blockedByAccountId.set(ownership.accountId, blocked);
    }

    for (const [accountId, teamIds] of blockedByAccountId) {
        decisions.set(accountId, {
            status: "rejected",
            code: "team_owner_transfer_required",
            teamIds,
        });
    }
    return decisions;
}

/**
 * May this Account be erased without stranding a Team it owns?
 *
 * The evaluation is per retained owner membership, and it is deliberately
 * insensitive to the target's own lifecycle state. An erasure retry arrives
 * with the Account already terminally Retired and its membership possibly
 * suspended; if the check read "is this an active owner" it would pass on the
 * retry and quietly finish an erasure the first attempt refused.
 *
 * With another structurally active owner present, removal is fine. Without one:
 *
 * - an archived Team may go ownerless — its rows are retained and its derived
 *   recovery state is exactly how it comes back;
 * - a Team with no other structurally active member may also go ownerless,
 *   because there is nobody left to strand;
 * - otherwise a live, staffed Team would lose its last owner, so erasure is
 *   refused and an explicit ownership transfer is required first.
 *
 * "Structurally active" means an active Account and an active membership.
 * Guests count as members here: a Team with a guest still has someone whose
 * access an ownerless Team would leave unadministered. Neither authentication
 * freshness nor envelope readiness is owner continuity, so neither appears.
 */
export async function assertTeamOwnershipAllowsAccountErasureInTx(
    tx: Tx,
    input: Readonly<{ accountId: string }>,
): Promise<TeamOwnershipErasureDecision> {
    const decisions = await readTeamOwnershipErasureDecisionsInTx(tx, { accountIds: [input.accountId] });
    return decisions.get(input.accountId) ?? { status: "ok" };
}
