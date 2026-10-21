import type { PublicProfileMutationResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { inTx } from '@/storage/inTx';
import { publicProfileUpdated } from './publicProfileStorage';
import { withdrawPublicProfileInTx } from './publicProfileWithdrawal';

/** Revocation is available while feature advertisement or source data is unavailable. */
export async function unpublishPublicProfile(accountId: string): Promise<PublicProfileMutationResultV1> {
    return inTx(async (tx): Promise<PublicProfileMutationResultV1> => {
        await withdrawPublicProfileInTx(tx, accountId);
        const row = await tx.accountPublicProfile.findUnique({ where: { accountId } });
        return row ? publicProfileUpdated(row) : { kind: 'updated', record: null };
    }, { isolationLevel: 'Serializable' });
}
