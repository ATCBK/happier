import type { Tx } from '@/storage/inTx';
import { publishTeamCredentialBrokerConsumersChangedInTx } from '@/app/teams/teamChanges';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

/** Personal sources stay opaque to Home; their only possible custodian is the
 * Session owner. Team source custody comes from the accepted brokered binding,
 * never Session readers or Team membership. This census also feeds admission. */
export async function readSessionProviderBrokerCustodianAccountIdsInTx(tx: Tx, sessionIds: readonly string[]): Promise<readonly string[]> {
    const accountIds = new Set<string>();
    // The nested binding read also binds the slot kind and Prisma OFFSET.
    for (const ids of portableQueryChunks({ values: [...new Set(sessionIds)], bindingsPerValue: 1, fixedBindings: 2 })) {
        const sessions = await tx.session.findMany({
            where: { id: { in: [...ids] } },
            select: { accountId: true, teamCredentialBindings: {
                where: { slotKind: 'provider_model:brokered' },
                select: { resource: { select: { custodianAccountId: true } } },
            } },
        });
        for (const session of sessions) {
            accountIds.add(session.accountId);
            for (const binding of session.teamCredentialBindings) accountIds.add(binding.resource.custodianAccountId);
        }
    }
    return [...accountIds].sort();
}

/** Called only after a real terminal write, before deletion can cascade bindings. */
export async function publishSessionProviderBrokerConsumersChangedInTx(tx: Tx, sessionId: string): Promise<void> {
    await publishTeamCredentialBrokerConsumersChangedInTx(tx, {
        custodianAccountIds: await readSessionProviderBrokerCustodianAccountIdsInTx(tx, [sessionId]),
    });
}
