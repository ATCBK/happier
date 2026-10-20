import { describe, expect, it } from 'vitest';

import { resolveApprovalRequestTitle } from './approvalRequestTitle';

describe('resolveApprovalRequestTitle', () => {
    const args = { controllerMachineId: 'machine-1', relationshipId: 'relationship_1' };

    it('titles a request by its Action when the stored first line only restates the request\'s own summary', () => {
        // A request stored before its Action copy was reworded still carries the old generated sentence.
        const stored = 'Synchronize this linked workspace relationship now.';
        const resolved = resolveApprovalRequestTitle({
            storedTitle: stored, previewSummary: stored, actionId: 'workspace.sync.relationship.flush', actionArgs: args,
        });
        expect(resolved.title).toBe('Sync workspace now');
        expect(resolved.actionTitle).toBeNull();
    });

    it('keeps an authored title that differs from the request summary', () => {
        const resolved = resolveApprovalRequestTitle({
            storedTitle: 'Release night sync', previewSummary: 'Synchronize these linked folders now.',
            actionId: 'workspace.sync.relationship.flush', actionArgs: args,
        });
        expect(resolved.title).toBe('Release night sync');
    });
});
