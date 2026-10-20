import { describe, expect, it } from 'vitest';
import { TargetActionApprovalRequestV1Schema } from '../approvals/targetActionApprovalRequestV1';
import { createTargetActionApprovalDecision } from './targetActionApprovalDecision';

function accountApproval() {
  return TargetActionApprovalRequestV1Schema.parse({ v: 1, kind: 'plugin_target_action', status: 'open',
    createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
    qualifiedActionId: 'acme.account/actions/write', input: { key: 'sample' }, secretInputPaths: [],
    approvalInputCustody: 'live_only', sourceCustody: { kind: 'development', registeredRootId: 'account-root' },
    policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Write Account data' });
}

describe('target Action approval decision custody', () => {
  it('records an Account decision when the original live invocation belongs to another process', async () => {
    let stored = accountApproval();
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async ({ request }) => { stored = request; return { ok: true }; } });
    expect(await decide({ artifactId: 'other-process', decision: 'approve' }))
      .toMatchObject({ ok: true, result: { status: 'approved' } });
    expect(stored).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
    expect(stored).not.toHaveProperty('execution');
  });

  it('reconciles a live execution claim observed before the decision write response', async () => {
    let stored = accountApproval();
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async ({ request }) => {
        stored = request.status === 'approved' ? TargetActionApprovalRequestV1Schema.parse({ ...request, status: 'executing' }) : request;
        return { ok: true };
      } });
    expect(await decide({ artifactId: 'already-claimed', decision: 'approve' }))
      .toMatchObject({ ok: true, result: { status: 'executing' } });
    expect(stored.status).toBe('executing');
  });
});
