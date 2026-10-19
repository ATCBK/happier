import { describe, expect, it } from 'vitest';

import { listDiscussionRequesterApprovals } from '@/sync/domains/artifacts/approvalArtifacts';
import { buildDiscussionRequesterApprovalArtifact } from '@/sync/domains/artifacts/approvalArtifacts.discussionRequester.testkit';
import type { ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { resolveApprovalRequesterThreadState } from './approvalRequesterThreadState';

function stateOf(settle?: (request: ApprovalRequestV2) => ApprovalRequestV2, recorded: 'approve' | 'reject' | null = null) {
    const [entry] = listDiscussionRequesterApprovals([buildDiscussionRequesterApprovalArtifact({ settle })],
        { serverId: 'server-1', discussionId: 'discussion-1' });
    if (!entry) throw new Error('Expected the requester approval');
    return resolveApprovalRequesterThreadState(entry.parsed, recorded);
}

const approved = (request: ApprovalRequestV2): ApprovalRequestV2 => ({ ...request, status: 'approved', updatedAtMs: 20,
    decision: { kind: 'approve', decidedAtMs: 20, authority: 'present_user', decidingAccountId: 'bob' } });

describe('resolveApprovalRequesterThreadState', () => {
    it('asks while open, and says the answer this device recorded until the request catches up', () => {
        expect(stateOf()).toEqual({ kind: 'open' });
        expect(stateOf(undefined, 'reject')).toEqual({ kind: 'declined', decidingAccountId: null });
        expect(stateOf(undefined, 'approve')).toEqual({ kind: 'confirmed_pending', decidingAccountId: null });
    });

    it('is a receipt only after effect evidence; an approved request without a result is still pending', () => {
        expect(stateOf(approved)).toEqual({ kind: 'confirmed_pending', decidingAccountId: 'bob' });
        expect(stateOf((request) => ({ ...approved(request), status: 'executed', updatedAtMs: 30,
            execution: { executedAtMs: 30, ok: true, result: { ok: true } } }))).toEqual({ kind: 'done', decidingAccountId: 'bob' });
    });

    it('never reads an unknown effect as success, and says a failure or a refusal plainly', () => {
        expect(stateOf((request) => ({ ...approved(request), status: 'failed', updatedAtMs: 30,
            execution: { executedAtMs: 30, ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' } })))
            .toEqual({ kind: 'uncertain', decidingAccountId: 'bob' });
        expect(stateOf((request) => ({ ...approved(request), status: 'failed', updatedAtMs: 30,
            execution: { executedAtMs: 30, ok: false, errorCode: 'action_failed', error: 'GitHub refused the write' } })))
            .toMatchObject({ kind: 'failed', decidingAccountId: 'bob' });
        expect(stateOf((request) => ({ ...request, status: 'rejected', updatedAtMs: 20,
            decision: { kind: 'reject', decidedAtMs: 20, authority: 'present_user', decidingAccountId: 'bob' } })))
            .toEqual({ kind: 'declined', decidingAccountId: 'bob' });
        expect(stateOf((request) => ({ ...request, status: 'canceled', updatedAtMs: 20 }))).toEqual({ kind: 'canceled' });
    });
});
