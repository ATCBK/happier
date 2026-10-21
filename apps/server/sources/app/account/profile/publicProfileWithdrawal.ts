import type { Tx } from '@/storage/inTx';

export const EMPTY_PUBLIC_PROFILE_PAYLOAD = { state: 'draft', policyJson: null, metadataJson: null, queryJson: null, snapshotJson: null,
    layoutJson: null, appearanceJson: null, publishedAt: null } as const;

/** Identity changes, unpublish and erasure share payload withdrawal, preserving operator restriction. */
export async function withdrawPublicProfileInTx(tx: Tx, accountId: string): Promise<void> {
    const row = await tx.accountPublicProfile.findUnique({ where: { accountId } });
    if (!row) return;
    if (row.removedAt) await tx.accountPublicProfile.update({ where: { accountId }, data: EMPTY_PUBLIC_PROFILE_PAYLOAD });
    else await tx.accountPublicProfile.delete({ where: { accountId } });
}

/** Provider recovery transfers restriction only, never the retired Account's disclosure. */
export async function replacePublicProfileForProviderResetInTx(tx: Tx, oldAccountId: string, replacementAccountId: string): Promise<void> {
    const row = await tx.accountPublicProfile.findUnique({ where: { accountId: oldAccountId } });
    if (row?.removedAt) await tx.accountPublicProfile.upsert({ where: { accountId: replacementAccountId },
        create: { accountId: replacementAccountId, ...EMPTY_PUBLIC_PROFILE_PAYLOAD, removedAt: row.removedAt, removedByAccountId: row.removedByAccountId, removalReason: row.removalReason },
        update: { ...EMPTY_PUBLIC_PROFILE_PAYLOAD, removedAt: row.removedAt, removedByAccountId: row.removedByAccountId, removalReason: row.removalReason } });
    await withdrawPublicProfileInTx(tx, oldAccountId);
}
