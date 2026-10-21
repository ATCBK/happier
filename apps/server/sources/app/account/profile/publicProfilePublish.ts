import { PublicProfilePublishBodyV1Schema, PublicProfileRefreshBodyV1Schema, PublicProfileAppearanceV1Schema,
    type PublicProfileMutationResultV1, type PublicProfilePublishBodyV1, type PublicProfileRefreshBodyV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfileSnapshot, projectPublicProfileMetadata, validatePublicProfileLayout } from '@happier-dev/protocol/account/projectPublicProfile';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { inTx } from '@/storage/inTx';
import { publicProfileUnavailable, publicProfileUpdated, type PublicProfileServerDependencies } from './publicProfileStorage';
import { replacePublicProfileSnapshotInTx } from './publicProfileRefresh';

/** Stores only the exact reviewed public disclosure, without changing Account mode or keys. */
export async function publishPublicProfile(accountId: string, input: PublicProfilePublishBodyV1, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileMutationResultV1> {
    const body = PublicProfilePublishBodyV1Schema.parse(input);
    const layout = validatePublicProfileLayout(body.layout);
    const appearance = PublicProfileAppearanceV1Schema.safeParse(body.appearance);
    if (!appearance.success) return publicProfileUnavailable('asset_unavailable');
    return inTx(async tx => {
        const context = await deps.readPublicationContext(tx, accountId, env);
        if (!context.handle) return publicProfileUnavailable('username_required');
        const prerequisite = deps.resolvePrerequisite(env);
        if (prerequisite) return publicProfileUnavailable(prerequisite);
        const row = await tx.accountPublicProfile.findUnique({ where: { accountId } });
        if (row?.removedAt) return publicProfileUnavailable('restricted');
        const metadata = projectPublicProfileMetadata(body.metadata, body.policy);
        const data = { state: 'published', policyJson: JSON.stringify(body.policy), metadataJson: JSON.stringify({ disclosure: metadata,
            projectSelections: body.policy.fields.projects ? body.projectSelections : [] }), queryJson: JSON.stringify(normalizeUsageQuery(body.query)),
            snapshotJson: JSON.stringify(projectPublicProfileSnapshot(body.snapshot, body.policy)), layoutJson: JSON.stringify(layout),
            appearanceJson: JSON.stringify(appearance.data), publishedAt: row?.publishedAt ?? new Date() };
        return publicProfileUpdated(await tx.accountPublicProfile.upsert({ where: { accountId }, create: { accountId, ...data }, update: data }));
    }, { isolationLevel: 'Serializable' });
}

/** Resume preserves the stored edition and consent, admitting fresh facts before publication. */
export async function resumePublicProfile(accountId: string, input: PublicProfileRefreshBodyV1,
    env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileMutationResultV1> {
    const body = PublicProfileRefreshBodyV1Schema.parse(input);
    return inTx(tx => replacePublicProfileSnapshotInTx(tx, accountId, body, env, deps, 'resume'), { isolationLevel: 'Serializable' });
}
