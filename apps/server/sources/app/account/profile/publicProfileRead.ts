import type { PublicProfileOwnerReadV1, PublicProfileReadResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfile, projectPublicProfileIdentity } from '@happier-dev/protocol/account/projectPublicProfile';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { readSnapshotWithCurrentAdmission } from '@/storage/readSnapshotWithCurrentAdmission';
import { parsePublicProfileRecord, type PublicProfileServerDependencies } from './publicProfileStorage';
import { readPublicProfilePicture } from './publicProfilePicture';
import { isServerFeatureEnabledForRequest } from '@/app/features/catalog/serverFeatureGate';

export interface PublicProfileDelivery {
    result: PublicProfileReadResultV1;
    picture?: Readonly<{ bytes: Buffer; mimeType: 'image/png'; width: number; height: number }>;
}

interface ResolvedPublicProfile {
    result: PublicProfileReadResultV1;
    accountId?: string;
}

interface MaterializedPublicProfile extends ResolvedPublicProfile {
    media?: Awaited<ReturnType<typeof readPublicProfilePicture>>;
    picture?: PublicProfileDelivery['picture'];
}

/** Owner recovery remains reachable even when public capability is unavailable. */
export async function readPublicProfileOwner(accountId: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileOwnerReadV1> {
    return inReadSnapshot(async (tx): Promise<PublicProfileOwnerReadV1> => {
        const context = await deps.readPublicationContext(tx, accountId, env);
        const row = await tx.accountPublicProfile.findUnique({ where: { accountId } });
        if (!row) return { kind: 'absent', context };
        const record = parsePublicProfileRecord(row);
        if (!record) throw new Error('invalid_stored_content');
        return { kind: 'ready', record, context };
    });
}

/** Public JSON shares the canonical projection without loading private media. */
export async function readPublicProfile(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileReadResultV1> {
    return (await resolvePublicProfile(handle, env, deps)).result;
}

/** Server delivery keeps physical media separate from the public JSON projection. */
export async function readPublicProfileDelivery(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileDelivery> {
    if (!isServerFeatureEnabledForRequest('account.publicProfiles', env)) return { result: { kind: 'unavailable' } };
    return readAdmittedPublicProfileDelivery(handle, env, deps);
}

/** Post-feature admission owns the current publication and its private media custody. */
export async function readAdmittedPublicProfileDelivery(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileDelivery> {
    const delivery = await readSnapshotWithCurrentAdmission<MaterializedPublicProfile, ResolvedPublicProfile>({
        capture: tx => resolvePublicProfileInTx(tx, handle, env, deps),
        materialize: async (captured): Promise<MaterializedPublicProfile> => {
            if (!captured.accountId || captured.result.kind !== 'published' || captured.result.view.appearance.atmosphere.source !== 'picture') return captured;
            const media = await readPublicProfilePicture({ accountId: captured.accountId,
                pictureId: captured.result.view.appearance.atmosphere.picture.ref.id });
            return { ...captured, media };
        },
    }, async (tx, captured) => {
        if (!captured.accountId) return { result: { kind: 'unavailable' } };
        const current = await resolvePublicProfileInTx(tx, handle, env, deps);
        if (current.accountId !== captured.accountId) return { result: { kind: 'unavailable' } };
        if (current.result.kind !== 'published') return { result: current.result };
        const atmosphere = current.result.view.appearance.atmosphere;
        if (atmosphere.source !== 'picture') return captured.media ? { result: { kind: 'unavailable' } } : { result: current.result };
        if (captured.result.kind !== 'published' || captured.result.view.appearance.atmosphere.source !== 'picture'
            || atmosphere.picture.ref.id !== captured.result.view.appearance.atmosphere.picture.ref.id || !captured.media) {
            return { result: { kind: 'unavailable' } };
        }
        // Current policy and the exact binding win over a failure reading a retired image.
        if (!captured.media.ok) {
            if (captured.media.reason === 'not_found') return { result: { kind: 'unavailable' } };
            throw new Error('public_profile_picture_unavailable');
        }
        return { result: current.result, picture: { bytes: Buffer.from(captured.media.bytes), mimeType: captured.media.mimeType,
            width: captured.media.width, height: captured.media.height } };
    });
    return { result: delivery.result, ...(delivery.picture ? { picture: delivery.picture } : {}) };
}

async function resolvePublicProfile(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<ResolvedPublicProfile> {
    if (!isServerFeatureEnabledForRequest('account.publicProfiles', env)) return { result: { kind: 'unavailable' } };
    return inReadSnapshot(tx => resolvePublicProfileInTx(tx, handle, env, deps));
}

async function resolvePublicProfileInTx(tx: Tx, handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<ResolvedPublicProfile> {
    const account = await tx.account.findUnique({ where: { username: handle }, select: { id: true } });
    if (!account) return { result: { kind: 'unavailable' } };
    return { result: await readAdmittedPublicProfileInTx(tx, account.id, handle, env, deps), accountId: account.id };
}

/** Captured Account consumers cannot follow a recycled handle to another Account. */
export async function readPublicProfileForAccount(accountId: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileReadResultV1> {
    if (!isServerFeatureEnabledForRequest('account.publicProfiles', env)) return { kind: 'unavailable' };
    return inReadSnapshot(async tx => {
        const account = await tx.account.findUnique({ where: { id: accountId }, select: { username: true } });
        if (!account?.username) return { kind: 'unavailable' };
        return readAdmittedPublicProfileInTx(tx, accountId, account.username, env, deps);
    });
}

async function readAdmittedPublicProfileInTx(tx: Tx, accountId: string, handle: string,
    env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileReadResultV1> {
    const row = await tx.accountPublicProfile.findUnique({ where: { accountId } });
    if (!row || row.removedAt || row.state === 'draft') return { kind: 'unavailable' };
    const current = parsePublicProfileRecord(row);
    if (!current?.policy) return { kind: 'unavailable' };
    const context = await deps.readPublicationContext(tx, accountId, env);
    if (row.state === 'paused') return { kind: 'paused', handle, identity: projectPublicProfileIdentity(context.identity, current.policy) };
    if (!current.snapshot || !current.metadata || !current.layout || !current.appearance) return { kind: 'unavailable' };
    try {
        const view = projectPublicProfile({ context, policy: current.policy, metadata: current.metadata,
            snapshot: current.snapshot, layout: current.layout, appearance: current.appearance });
        return view ? { kind: 'published', view } : { kind: 'unavailable' };
    } catch { return { kind: 'unavailable' }; }
}
