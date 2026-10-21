import { PublicProfileUpdateBodyV1Schema, PublicProfileAppearanceV1Schema, type PublicProfileMutationResultV1, type PublicProfileUpdateBodyV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfileSnapshot, projectPublicProfileMetadata, validatePublicProfileLayout } from '@happier-dev/protocol/account/projectPublicProfile';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { inTx } from '@/storage/inTx';
import { parsePublicProfileRecord, publicProfileUnavailable, publicProfileUpdated } from './publicProfileStorage';

/** Commits disclosure edits independently of optional source refresh, preserving omitted consent. */
export async function updatePublicProfile(accountId: string, input: PublicProfileUpdateBodyV1): Promise<PublicProfileMutationResultV1> {
    const body = PublicProfileUpdateBodyV1Schema.parse(input);
    const layout = body.layout && validatePublicProfileLayout(body.layout);
    const appearance = body.appearance && PublicProfileAppearanceV1Schema.safeParse(body.appearance);
    if (appearance && !appearance.success) return publicProfileUnavailable('asset_unavailable');
    return inTx(async tx => {
        const row = await tx.accountPublicProfile.findUnique({ where: { accountId } });
        if (!row || row.state === 'draft') return publicProfileUnavailable('not_published');
        if (row.removedAt) return publicProfileUnavailable('restricted');
        const current = parsePublicProfileRecord(row);
        if (!current?.policy || !current.metadata || !current.query) return publicProfileUnavailable('invalid_stored_content');
        const policy = body.policy ?? current.policy;
        const metadata = projectPublicProfileMetadata(body.metadata ?? current.metadata, policy);
        const query = body.query ? normalizeUsageQuery(body.query) : current.query;
        const queryChanged = getUsageQueryKey(query) !== getUsageQueryKey(current.query);
        return publicProfileUpdated(await tx.accountPublicProfile.update({ where: { accountId }, data: {
            policyJson: JSON.stringify(policy), metadataJson: JSON.stringify({ disclosure: metadata,
                projectSelections: policy.fields.projects ? body.projectSelections ?? current.projectSelections : [] }),
            queryJson: JSON.stringify(query), snapshotJson: queryChanged || !current.snapshot ? null : JSON.stringify(projectPublicProfileSnapshot(current.snapshot, policy)),
            ...(layout ? { layoutJson: JSON.stringify(layout) } : {}), ...(appearance?.success ? { appearanceJson: JSON.stringify(appearance.data) } : {}),
        } }));
    }, { isolationLevel: 'Serializable' });
}
