import type { Tx } from "@/storage/inTx";
import { acquireAccountChangePublicationLocksInTx } from "@/app/changes/markAccountChanged";
import { publishTeamChangedInTx } from "../teamChanges";

/**
 * Clears Pool placement at the credential-resource owner. Resource revision is
 * advanced in the same transaction so every signed/open authority admitted
 * against the deleted placement fails through the incumbent currentness gate.
 */
export async function clearTeamCredentialBrokerPoolReferencesInTx(
    tx: Tx,
    input: Readonly<{ custodianAccountId: string; poolId: string }>,
): Promise<void> {
    await acquireAccountChangePublicationLocksInTx(tx, [input.custodianAccountId], { includeSingleAccount: true });
    const affected = await tx.teamCredentialResource.findMany({
        where: { custodianAccountId: input.custodianAccountId, brokerPoolId: input.poolId },
        select: { teamId: true },
    });
    if (affected.length === 0) return;
    await tx.teamCredentialResource.updateMany({
        where: { custodianAccountId: input.custodianAccountId, brokerPoolId: input.poolId },
        data: { brokerPoolId: null, revision: { increment: 1 } },
    });
    for (const teamId of new Set(affected.map((row) => row.teamId))) {
        await publishTeamChangedInTx(tx, {
            teamId,
            additionalAccountIds: [input.custodianAccountId],
        });
    }
}
