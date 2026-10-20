import type { ActionApprovalContinuation, ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import {
    executeManagedIdentityProviderRead,
    type ManagedIdentityProviderActionResult,
    type ManagedIdentityProviderExecuteOptions,
} from './managedIdentityProviderClient';

type RemovalBlockers = Readonly<{
    identityCount: number;
    connectionCount: number;
    affectedAccountIds: readonly string[];
}>;

type RemovalPreflight = Readonly<{
    provider: Readonly<{ id: string; revision: number }>;
    canRemove: boolean;
    blockers: RemovalBlockers;
}>;

export type ManagedIdentityProviderRemovalOutcome =
    | Readonly<{ kind: 'removed' }>
    | Readonly<{ kind: 'approval_pending'; artifactId: string; approval: ActionApprovalContinuation }>
    | Readonly<{ kind: 'blocked'; blockers: RemovalBlockers }>
    | Readonly<{ kind: 'failed'; code: string }>;

export async function runManagedIdentityProviderRemoval(params: Readonly<{
    providerId: string;
    readPreflight: (options?: ManagedIdentityProviderExecuteOptions<RemovalPreflight>) => Promise<ManagedIdentityProviderActionResult<RemovalPreflight>>;
    onApprovalPending?: (registration: ActionApprovalRegistration) => void;
    remove: (expectedRevision: number) => Promise<ManagedIdentityProviderActionResult<Readonly<{ outcome: 'removed' }>>>;
}>): Promise<ManagedIdentityProviderRemovalOutcome> {
    // A configured read may itself require approval. Keep the impact review
    // mounted until the existing continuation settles; never issue the read a
    // second time or confirm against a fabricated/partial projection.
    const preflight = await executeManagedIdentityProviderRead(
        params.readPreflight,
        { onApprovalPending: params.onApprovalPending },
    );
    if (preflight.kind === 'failed') return { kind: 'failed', code: preflight.failure.code };
    if (preflight.value.provider.id !== params.providerId) {
        return { kind: 'failed', code: 'identity_provider_revision_conflict' };
    }
    if (!preflight.value.canRemove) {
        return { kind: 'blocked', blockers: preflight.value.blockers };
    }
    const removed = await params.remove(preflight.value.provider.revision);
    if (removed.kind === 'approval_pending') return removed;
    return removed.kind === 'succeeded' ? { kind: 'removed' } : { kind: 'failed', code: removed.failure.code };
}
