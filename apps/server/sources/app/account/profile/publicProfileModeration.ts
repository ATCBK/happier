import type { HomePublicProfileModerationResultV1 } from '@happier-dev/protocol/home/governance';
import { inTx } from '@/storage/inTx';
import { authorizeHomeGovernanceMutationInTx } from '@/app/home/governance/homeCapabilities';
import { recordHomeAdministrationEventInTx } from '@/app/home/audit/homeAdministrationEvents';
import { publishHomeGovernanceChangedInTx } from '@/app/home/governance/governanceChanges';

export type PublicProfileModerationResult = HomePublicProfileModerationResultV1 | { kind: 'forbidden' } | { kind: 'not_found' };
/** Restriction is operator state on the publication row, independent of owner disclosure. */
export async function moderatePublicProfile(actorAccountId: string, accountId: string, operation: 'restrict' | 'restore', reason: string): Promise<PublicProfileModerationResult> {
    return inTx(async (tx): Promise<PublicProfileModerationResult> => {
        const authorization = await authorizeHomeGovernanceMutationInTx(tx, { actorAccountId,
            request: { operation: 'manage_public_profile', targetAccountId: accountId } });
        if (authorization.status === 'rejected') return { kind: authorization.code === 'home_account_not_found' ? 'not_found' : 'forbidden' };
        const row = await tx.accountPublicProfile.findUnique({ where: { accountId } });
        if (operation === 'restore' && !row) return { kind: 'updated', record: null };
        const data = operation === 'restrict'
            ? { removedAt: row?.removedAt ?? new Date(), removedByAccountId: actorAccountId, removalReason: reason }
            : { removedAt: null, removedByAccountId: null, removalReason: null };
        await tx.accountPublicProfile.upsert({ where: { accountId }, create: { accountId, ...data }, update: data });
        await recordHomeAdministrationEventInTx(tx, { actor: { kind: 'account', accountId: actorAccountId },
            target: { kind: 'account', id: accountId }, detail: { action: operation === 'restrict' ? 'public_profile.restricted' : 'public_profile.restored', summary: { reason } } });
        await publishHomeGovernanceChangedInTx(tx);
        return { kind: 'updated', record: null };
    }, { isolationLevel: 'Serializable' });
}
