import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createModalModuleMock } from '@/dev/testkit/mocks/modal';

const modal = vi.hoisted(() => ({ show: vi.fn(() => 'modal-id') }));

vi.mock('@/modal', async () => createModalModuleMock({ spies: { show: modal.show } }).module);

const { openWorkspaceSyncRelationshipDetails } = await import('./openWorkspaceSyncRelationshipDetails');

describe('openWorkspaceSyncRelationshipDetails', () => {
    beforeEach(() => modal.show.mockClear());

    it('leaves scrolling to the existing details view for narrow and large-text layouts', () => {
        openWorkspaceSyncRelationshipDetails({
            relationshipId: 'relationship-1',
            relationship: {
                v: 1,
                relationshipId: 'relationship-1',
                controllerMachineId: 'machine-a',
                alphaWorkspaceRefId: 'workspace-a',
                betaWorkspaceRefId: 'workspace-b',
                mode: 'keep_synced',
                contentPolicy: { v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [], policyDigest: 'sha256:test' },
                enabled: true,
                createdAtMs: 1,
                updatedAtMs: 1,
            },
            alpha: { workspaceRefId: 'workspace-a', workspaceRef: null, label: 'A', name: 'A', machineName: 'Machine A' },
            beta: { workspaceRefId: 'workspace-b', workspaceRef: null, label: 'B', name: 'B', machineName: 'Machine B' },
            status: null,
        });

        expect(modal.show).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({ bodyScroll: 'none' }),
        }));
    });
});
