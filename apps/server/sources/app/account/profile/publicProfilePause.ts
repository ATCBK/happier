import type { PublicProfileMutationResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { inTx } from '@/storage/inTx';
import { publicProfileUnavailable, publicProfileUpdated } from './publicProfileStorage';

/** Pausing suppresses all public facts while retaining the reviewed edition. */
export async function pausePublicProfile(accountId: string): Promise<PublicProfileMutationResultV1> {
    return inTx(async tx => {
        const row = await tx.accountPublicProfile.findUnique({ where: { accountId } });
        if (!row || row.state === 'draft') return publicProfileUnavailable('not_published');
        return publicProfileUpdated(await tx.accountPublicProfile.update({ where: { accountId }, data: { state: 'paused' } }));
    }, { isolationLevel: 'Serializable' });
}
