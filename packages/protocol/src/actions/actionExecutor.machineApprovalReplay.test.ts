import { describe, expect, it } from 'vitest';

import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';

describe('Machine approval replay composition', () => {
  it('reconstructs the approved Machine target before the filesystem owner executes', async () => {
    let stored: ApprovalRequest | null = null;
    const receivedContexts: ActionExecutorContext[] = [];
    const executor = createActionExecutor({
      isActionApprovalRequired: (actionId) => actionId === 'daemon.filesystem.writeFile',
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'machine-write-approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('missing_approval');
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      // The filesystem port is the genuine process boundary. Keep its production
      // target admission here so a missing or miswired replay target fails RED.
      filesystemActionExecute: async ({ context }) => {
        receivedContexts.push(context);
        return context.externalActionTarget?.kind === 'machine'
          && context.externalActionTarget.machineId === 'machine-1'
          ? { success: true, hash: 'written-hash' }
          : { ok: false, errorCode: 'target_unavailable', error: 'Filesystem target is unavailable' };
      },
    } satisfies ActionExecutorDeps);

    const pending = await executor.execute('daemon.filesystem.writeFile', {
      rootPath: '/workspace', path: 'approved.txt', content: 'b2s=',
    }, {
      surface: 'agent', authority: 'account_automation', serverId: 'server-1',
      actionRequestId: 'agent-write-1', defaultSessionId: 'session-1',
      defaultSessionMachineId: 'machine-1',
      actionCaller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
    });
    expect(pending).toMatchObject({ ok: true, result: { artifactId: 'machine-write-approval' } });
    expect(stored).toMatchObject({ executionOriginV1: { machineId: 'machine-1' } });
    expect(stored).not.toMatchObject({ executionOriginV1: { target: expect.anything() } });

    const decided = await executor.execute('approval.request.decide', {
      artifactId: 'machine-write-approval', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server-1' });

    expect(receivedContexts).toHaveLength(1);
    expect(receivedContexts[0]?.externalActionTarget).toEqual({ kind: 'machine', machineId: 'machine-1' });
    expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
  });
});
