import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createEphemeralComposerDocumentOwner } from './composerDocumentOwner';
import { withdrawPendingMessageToComposerWithActionApproval } from './pendingMessageComposerDocumentOwner';

const scope = { serverId: 'home', accountId: 'account' };
const document = { text: 'Original typed input', structuredInputMentions: [], composerAttachments: [] };

// The real Action executor and approval policy run; the confirmation dialog, approval store and withdraw owner are the boundaries.
async function withdraw(confirm: boolean) {
    const record = { confirmations: 0, withdrawals: 0, approvals: 0 };
    const executor = createActionExecutor({
        isActionApprovalRequired: (actionId, context, input) =>
            isApprovalRequiredByActionsSettings(actionId, normalizeActionsSettingsV1({ v: 1 }), context, undefined, undefined, input),
        presentUserActionConfirmation: async () => { record.confirmations += 1; return confirm; },
        approvalsCreate: async () => { record.approvals += 1; return { artifactId: 'approval-1' }; },
        sessionPendingWithdraw: async () => { record.withdrawals += 1; return { outcome: 'removed' }; },
    } as Partial<ActionExecutorDeps> as ActionExecutorDeps);
    const composer = createEphemeralComposerDocumentOwner({
        ref: { kind: 'session', sessionId: 'session-a' }, capabilities: { text: true, references: true, attachments: true, submit: true },
    });
    const result = await withdrawPendingMessageToComposerWithActionApproval({
        composer, document, isCurrent: () => true, actionExecutor: executor, scope,
        withdrawInput: { sessionId: 'session-a', localId: 'pending-a', serverId: scope.serverId },
        context: { serverId: scope.serverId, surface: 'ui', authority: 'present_user', defaultSessionId: 'session-a' },
        registerApproval: () => { record.approvals += 1; },
    });
    return { result, record };
}

describe('pending withdrawal default confirmation', () => {
    it('confirms in place, then withdraws and restores the draft, without an approval Artifact', async () => {
        const { result, record } = await withdraw(true);
        expect(result).toEqual({ outcome: 'removed', status: 'restored' });
        expect(record).toEqual({ confirmations: 1, withdrawals: 1, approvals: 0 });
    });

    it('withdraws nothing when the person declines the confirmation', async () => {
        const { result, record } = await withdraw(false);
        expect(result.status).toBe('not_removed');
        expect(record).toEqual({ confirmations: 1, withdrawals: 0, approvals: 0 });
    });
});
