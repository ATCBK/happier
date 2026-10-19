import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

import { applyExternalGroupContributionInTx } from "./externalFacts";
import { sessionHistoryAccessOf } from "./sessionHistory";
import { withTeamSessionAccessEffectsInTx } from "./sessionAccessEffects";

type GroupBinding = Readonly<{
    id: string;
    teamGroupId: string;
    externalGroupId: string;
}>;

/**
 * The one comparison between a configured external Group key and a provider's
 * canonical observed Group values. Sign-in refresh and administrator test
 * diagnostics must agree, so neither may compare these strings on its own.
 */
export function selectMatchingExternalGroupIds(
    configuredExternalGroupIds: readonly string[],
    observedGroupValues: Iterable<string>,
): Set<string> {
    const observed = new Set(observedGroupValues);
    return new Set(configuredExternalGroupIds.filter(
        (externalGroupId) => observed.has(externalGroupId.trim().toLowerCase()),
    ));
}

function sameBindings(a: readonly GroupBinding[], b: readonly GroupBinding[]): boolean {
    return a.length === b.length && a.every((left, index) => {
        const right = b[index];
        return right?.id === left.id
            && right.teamGroupId === left.teamGroupId
            && right.externalGroupId === left.externalGroupId;
    });
}

/**
 * Prepares one complete sign-in observation outside the finalization transaction,
 * then reapplies it only if the exact connection bindings are still current.
 */
export async function prepareIdentityConnectionGroupRefresh(input: Readonly<{
    accountId: string;
    teamId: string;
    connectionId: string;
    observeActiveExternalGroupIds: (
        configuredExternalGroupIds: readonly string[],
    ) => Promise<ReadonlySet<string> | null>;
}>): Promise<Readonly<{ applyInTx: (tx: Tx) => Promise<void> }> | null> {
    const bindings = await db.teamExternalGroupBinding.findMany({
        where: {
            teamId: input.teamId,
            teamIdentityConnectionId: input.connectionId,
        },
        orderBy: { id: "asc" },
        select: { id: true, teamGroupId: true, externalGroupId: true },
    });
    const activeExternalGroupIds = await input.observeActiveExternalGroupIds(
        bindings.map((binding) => binding.externalGroupId),
    );
    if (activeExternalGroupIds === null) return null;

    return {
        applyInTx: async (tx) => {
            const currentBindings = await tx.teamExternalGroupBinding.findMany({
                where: {
                    teamId: input.teamId,
                    teamIdentityConnectionId: input.connectionId,
                },
                orderBy: { id: "asc" },
                select: { id: true, teamGroupId: true, externalGroupId: true },
            });
            if (!sameBindings(bindings, currentBindings)) return;
            const membership = await tx.teamMembership.findUnique({
                where: {
                    teamId_accountId: { teamId: input.teamId, accountId: input.accountId },
                },
                select: { sessionAccessStartsAt: true },
            });
            if (!membership) return;
            const historyAccess = sessionHistoryAccessOf(membership.sessionAccessStartsAt);
            await withTeamSessionAccessEffectsInTx(tx, {
                teamId: input.teamId,
                // The contribution owner below classifies each current row. A
                // replay starts retained and is upgraded only if one binding
                // creates the first effective Group relationship.
                accountIds: [input.accountId],
                change: {
                    kind: "teamGroupMembership",
                    teamId: input.teamId,
                    teamGroupIds: currentBindings.map((binding) => binding.teamGroupId),
                },
            }, async (sessionAccessImpacts) => {
                for (const binding of currentBindings) {
                    await applyExternalGroupContributionInTx(tx, {
                        teamId: input.teamId,
                        groupId: binding.teamGroupId,
                        accountId: input.accountId,
                        externalGroupBindingId: binding.id,
                        desired: activeExternalGroupIds.has(binding.externalGroupId) ? "present" : "absent",
                        historyAccess,
                        sessionAccessImpacts,
                    });
                }
            });
        },
    };
}
