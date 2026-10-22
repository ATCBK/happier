import { describe, expect, it } from 'vitest';
import { TargetActionApprovalRequestV1Schema } from '../approvals/targetActionApprovalRequestV1';
import { createTargetActionApprovalDecision } from './targetActionApprovalDecision';
import { getActionSpec } from './actionSpecs';
import { admitTargetActionApprovalTransition } from '../approvals/targetActionApprovalRequestTransition';

function accountApproval() {
  return TargetActionApprovalRequestV1Schema.parse({ v: 1, kind: 'plugin_target_action', status: 'open',
    createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
    qualifiedActionId: 'acme.account/actions/write', input: { key: 'sample' }, secretInputPaths: [],
    approvalInputCustody: 'live_only', sourceCustody: { kind: 'development', registeredRootId: 'account-root' },
    policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Write Account data' });
}

describe('target Action approval decision custody', () => {
  it.each(['approve', 'reject', 'cancel'] as const)('refuses subjectless requester-only contributed %s before consent', async decision => {
    let stored = accountApproval();
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async ({ request }) => { stored = request; return { ok: true }; } });
    expect(await decide({ artifactId: 'owner-only', decision, context: {
      surface: 'rpc', authority: 'present_user', runtimeAccountId: 'alice', requesterApprovalDecision: {
        sessionId: 's1', actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' },
        isCurrent: async () => true,
      },
    } })).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(stored.status).toBe('open');
  });

  it.each(['open', 'approved'] as const)('refuses retained unknown contributed %s before execution', async status => {
    let stored = TargetActionApprovalRequestV1Schema.parse({ ...accountApproval(), status,
      ...(status === 'approved' ? { decision: { kind: 'approve', decidedAtMs: 2 } } : {}),
      executionOriginV1: { v: 1, actionId: 'action.invoke', requestId: 'retained', authority: 'account_automation',
        surface: 'agent', caller: { kind: 'host' }, serverId: 'home', accountId: 'alice', machineId: 'machine',
        actionRequestAttributionV1: { requestRef: 'unknown', requester: null,
          persona: { serverId: 'home', sessionId: 's1' }, origin: null } } });
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async ({ request }) => { stored = request; return { ok: true }; } });
    expect(await decide({ artifactId: 'unknown', decision: 'approve', context: {
      surface: 'ui', authority: 'present_user', runtimeAccountId: 'alice',
    } })).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(stored.status).toBe(status);
  });

  it.each([false, true])('settles an unclaimed approved target Action without racing execution (claim wins: %s)', async claimWins => {
    let stored = TargetActionApprovalRequestV1Schema.parse({ ...accountApproval(), status: 'approved',
      decision: { kind: 'approve', decidedAtMs: 2 } });
    const decide = createTargetActionApprovalDecision({ read: async () => stored, hasLiveInvocation: () => false,
      update: async ({ request }) => {
        if (claimWins) stored = TargetActionApprovalRequestV1Schema.parse({ ...stored, status: 'executing' });
        const transition = admitTargetActionApprovalTransition(stored, request);
        if (!transition.ok) return transition;
        stored = TargetActionApprovalRequestV1Schema.parse(request);
        return { ok: true };
      } });
    const canceled = await decide({ artifactId: 'unclaimed', decision: 'cancel' });
    if (claimWins) {
      expect(canceled).toMatchObject({ ok: false, errorCode: 'invalid_transition' });
      expect(stored.status).toBe('executing');
      expect(stored.execution).toBeUndefined();
    } else {
      expect(canceled).toMatchObject({ ok: true, result: { status: 'failed',
        execution: { ok: false, effectAttempted: false, errorCode: 'approval_canceled' } } });
      expect(stored.decision).toEqual({ kind: 'approve', decidedAtMs: 2 });
      expect(getActionSpec('approval.request.decide').outputSchema?.safeParse(canceled?.ok ? canceled.result : null).success).toBe(true);
      expect(await decide({ artifactId: 'unclaimed', decision: 'cancel' })).toEqual(canceled);
      expect(await decide({ artifactId: 'unclaimed', decision: 'approve' })).toEqual(canceled);
    }
  });

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
    const decided = await decide({ artifactId: 'already-claimed', decision: 'approve' });
    expect(decided).toMatchObject({ ok: true, result: { status: 'executing' } });
    if (!decided?.ok) throw new Error('Missing approval decision');
    expect(getActionSpec('approval.request.decide').outputSchema?.safeParse(decided.result).success).toBe(true);
    expect(stored.status).toBe('executing');
  });
});
