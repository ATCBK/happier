import { describe, expect, it, vi } from 'vitest';

import { runManagedIdentityProviderRemoval } from './managedIdentityProviderRemoval';

describe('runManagedIdentityProviderRemoval', () => {
    const approval = { artifactId: 'approval-1', onExecuted: async () => 'consumed' as const };
    const readApproval = { artifactId: 'approval-read', onExecuted: async () => 'consumed' as const };
    const preflight = {
        provider: { id: 'provider-1', revision: 4 },
        canRemove: true,
        blockers: { identityCount: 0, connectionCount: 0, affectedAccountIds: [] },
    };

    it('reports blockers without mutation', async () => {
        const remove = vi.fn();
        const blocked = { ...preflight, canRemove: false, blockers: { identityCount: 2, connectionCount: 1, affectedAccountIds: ['account-1'] } };
        const result = await runManagedIdentityProviderRemoval({
            providerId: 'provider-1',
            readPreflight: async () => ({ kind: 'succeeded', value: blocked }),
            remove,
        });
        expect(result).toEqual({ kind: 'blocked', blockers: blocked.blockers });
        expect(remove).not.toHaveBeenCalled();
    });

    it('awaits a read-only preflight approval before removal', async () => {
        const result = await runManagedIdentityProviderRemoval({
            providerId: 'provider-1',
            readPreflight: async (options) => {
                await options?.onApprovalSucceeded?.(preflight);
                return { kind: 'approval_pending', artifactId: readApproval.artifactId, approval: readApproval };
            },
            remove: async () => ({ kind: 'succeeded' as const, value: { outcome: 'removed' as const } }),
        });

        expect(result).toEqual({ kind: 'removed' });
    });

    it('uses the preflight revision and delegates confirmation to the removal Action', async () => {
        const remove = vi.fn(async () => ({ kind: 'succeeded' as const, value: { outcome: 'removed' as const } }));
        const result = await runManagedIdentityProviderRemoval({
            providerId: 'provider-1',
            readPreflight: async () => ({ kind: 'succeeded', value: preflight }),
            remove,
        });
        expect(result).toEqual({ kind: 'removed' });
        expect(remove).toHaveBeenCalledWith(4);
    });

    it('returns the pending approval without claiming the provider was removed', async () => {
        const result = await runManagedIdentityProviderRemoval({
            providerId: 'provider-1',
            readPreflight: async () => ({ kind: 'succeeded', value: preflight }),
            remove: async () => ({ kind: 'approval_pending', artifactId: 'approval-1', approval }),
        });

        expect(result).toEqual({ kind: 'approval_pending', artifactId: 'approval-1', approval });
    });
});
