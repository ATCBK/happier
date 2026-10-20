import { describe, expect, it, vi } from 'vitest';

import { runDirectorySourceRemoval } from './directorySourceRemoval';

const impact = {
    v: 1 as const,
    status: 'allowed' as const,
    sourceId: 'source-1',
    sourceLabel: 'Acme directory',
    impact: {
        teamMembershipsRemoved: 2,
        groupMembershipsRemoved: 6,
        groupContributionsRemoved: 3,
        directoryCreatedGroupsRetained: 1,
        nativeMembershipsPreserved: 4,
        nativeGroupContributionsPreserved: 5,
    },
};

describe('runDirectorySourceRemoval', () => {
    it('rejects a stale cross-source impact before mutation', async () => {
        const remove = vi.fn();

        const result = await runDirectorySourceRemoval({
            sourceId: 'source-2',
            readImpact: async () => ({ ok: true, value: impact }),
            remove,
        });

        expect(result).toEqual({ kind: 'failed', code: 'directory_source_changed' });
        expect(remove).not.toHaveBeenCalled();
    });

    it('delegates confirmation to the removal Action after current-source preflight', async () => {
        const remove = vi.fn(async () => ({ ok: true as const, value: { v: 1 as const, status: 'removed' as const, impact: impact.impact } }));

        const result = await runDirectorySourceRemoval({
            sourceId: 'source-1',
            readImpact: async () => ({ ok: true, value: impact }),
            remove,
        });

        expect(result).toEqual({ kind: 'removed' });
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it('fails closed without mutation when the fresh impact read is unavailable', async () => {
        const remove = vi.fn();

        const result = await runDirectorySourceRemoval({
            sourceId: 'source-1',
            readImpact: async () => ({
                ok: false as const,
                failure: { code: 'directory_source_not_found' as const, retryable: false as const },
            }),
            remove,
        });

        expect(result).toEqual({ kind: 'failed', code: 'directory_source_not_found' });
        expect(remove).not.toHaveBeenCalled();
    });
});
