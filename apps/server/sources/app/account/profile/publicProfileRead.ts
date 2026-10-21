import type { PublicProfileOwnerReadV1, PublicProfileReadResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfile, projectPublicProfileIdentity } from '@happier-dev/protocol/account/projectPublicProfile';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { parsePublicProfileRecord, type PublicProfileServerDependencies } from './publicProfileStorage';
import { isServerFeatureEnabledForRequest } from '@/app/features/catalog/serverFeatureGate';

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

/** Every anonymous representation enters here before considering its validator. */
export async function readPublicProfile(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileReadResultV1> {
    if (!isServerFeatureEnabledForRequest('account.publicProfiles', env)) return { kind: 'unavailable' };
    return inReadSnapshot(async (tx): Promise<PublicProfileReadResultV1> => {
        const account = await tx.account.findUnique({ where: { username: handle }, select: { id: true } });
        if (!account) return { kind: 'unavailable' };
        return readAdmittedPublicProfileInTx(tx, account.id, handle, env, deps);
    });
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
