import type { HomePublicProfileHandleReclaimInputV1, HomePublicProfileHandleReclaimResultV1 } from '@happier-dev/protocol/home/governance';
import { Context } from '@/context';
import { inTx } from '@/storage/inTx';
import { authorizeHomeGovernanceMutationInTx } from '@/app/home/governance/homeCapabilities';
import { recordHomeAdministrationEventInTx } from '@/app/home/audit/homeAdministrationEvents';
import { acquireHomeGovernanceAdmissionInTx, publishHomeGovernanceChangedInTx } from '@/app/home/governance/governanceChanges';
import { feedPost } from '@/app/feed/feedPost';
import { changeUsernameInTx, UsernameChangedError } from '@/app/social/usernameUpdate';

export type PublicProfileHandleReclaimResult = HomePublicProfileHandleReclaimResultV1
    | { kind: 'forbidden' | 'not_found' | 'username_changed' };

/** Reclaim identity, withdraw disclosure, and commit its audit and existing owner-feed notice together. */
export async function reclaimPublicProfileHandle(actorAccountId: string, input: HomePublicProfileHandleReclaimInputV1): Promise<PublicProfileHandleReclaimResult> {
    return inTx(async (tx): Promise<PublicProfileHandleReclaimResult> => {
        await acquireHomeGovernanceAdmissionInTx(tx, { accountIds: [actorAccountId, input.accountId], intent: 'exclusive' });
        const authorization = await authorizeHomeGovernanceMutationInTx(tx, { actorAccountId,
            request: { operation: 'manage_public_profile', targetAccountId: input.accountId } });
        if (authorization.status === 'rejected') return { kind: authorization.code === 'home_account_not_found' ? 'not_found' : 'forbidden' };
        let result: HomePublicProfileHandleReclaimResultV1;
        try {
            result = await changeUsernameInTx(tx, input.accountId, { kind: 'operator_reclaim', username: input.username });
        } catch (error) {
            if (error instanceof UsernameChangedError) return { kind: 'username_changed' };
            throw error;
        }
        if (!result.reclaimed) return result;
        await recordHomeAdministrationEventInTx(tx, { actor: { kind: 'account', accountId: actorAccountId },
            target: { kind: 'account', id: input.accountId }, detail: { action: 'public_profile.handle_reclaimed',
                summary: { username: input.username, reason: input.reason, notice: input.notice } } });
        await feedPost(tx, Context.create(input.accountId), { kind: 'text', text: input.notice }, 'public_profile_handle_reclaim');
        await publishHomeGovernanceChangedInTx(tx);
        return result;
    }, { isolationLevel: 'ReadCommitted' });
}
