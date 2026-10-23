import { describe, expect, it } from 'vitest';
import { createActionExecutor, buildActionExecuteResultFromRecordedApprovalExecution } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { WorkflowProgressEnvelopeV1Schema, WorkflowRunInvocationIndexV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createDaemonApprovalExecutionOriginCurrentness } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createWorkflowAcceptedAuthorizationCurrentness } from './daemonRuntime';
import { createWorkflowRunStorageTestkit, createPlainWorkflowRunKeyCensusFixture } from './workflowRunStorage.testkit';
import type { WorkflowRunStorageOperation } from './workflowRunStorageClient';

describe('Workflow model reservation approval custody', () => {
  it.each(['missing-run', 'wrong-discussion', 'wrong-slot', 'wrong-invocation', 'wrong-request', 'wrong-launch',
    'wrong-authorization', 'cancelled', 'terminal', 'cancel-requested', 'reclaim',
    'cancel-before-final-root', 'cancel-after-final-root', 'cancel-during-accepted-snapshot',
    'cancelled-root', 'terminal-root'] as const)(
    'replays only the exact live accepted invitation (%s)', async variant => {
      const runId = 'accepted-run';
      const slot = `workflow:${runId}:invocation-1`;
      const launch = { executionTarget: { serverId: 'home', machineId: 'machine' },
        directory: { kind: 'path' as const, path: '/repo' },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
      const origin = { kind: 'direct' as const, discussion: {
        discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 } };
      const materialized = await materializeWorkflowAcceptedSnapshotV1({
        definition: { version: 1, defaults: {}, inputs: [{ name: 'reviewer', valueType: 'json', required: true,
          inputType: { hostType: 'agentParticipant' } }], blocks: [{ kind: 'step', id: 'review', input: [],
          result: { kind: 'text' }, document: { text: 'Review', references: [], attachments: [] },
          execution: { participant: { kind: 'input', name: 'reviewer' } } }] },
        context: { source: { kind: 'inline' }, inputs: { reviewer: { kind: 'model', launch } }, machineId: 'machine',
          executionTarget: { kind: 'session' }, workspaceTarget: { project: {
            machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } }, origin,
          authorization: { principal: { kind: 'host' } } },
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
      });
      if (!materialized.ok) throw new Error(materialized.error.code);
      const accepted = materialized.snapshot;
      const input = { discussionId: 'discussion', participant: { kind: 'model', participantSlotId: slot, launch } };
      let request = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'agent' }, requestedSurface: 'agent', summary: 'Review invitation',
        actionId: 'discussion.invite', actionArgs: input, approval: { flow: 'deferred', result: 'none' },
        decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
          caller: { kind: 'workflowRun', runId, authorization: accepted.authorization,
            discussionModelReservation: { discussionId: 'discussion', participantSlotId: slot } },
          serverId: 'home', serverIdentityId: 'srv_home', accountId: 'account', machineId: 'machine',
          target: { kind: 'machine', machineId: 'machine' }, actionId: 'discussion.invite', requestId: `${slot}:discussion.invite` },
      });
      const census = createPlainWorkflowRunKeyCensusFixture({ runId, accountId: 'account' });
      const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine', accountId: 'account',
        origin, state: variant === 'cancelled' ? 'cancelled' : variant === 'terminal' ? 'succeeded' : 'interrupted',
        acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
          mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account', runId }, acceptedSnapshot: accepted })),
      });
      const row = (id: string) => {
        const root = id === 'root';
        const index = WorkflowRunInvocationIndexV1Schema.parse({ id, runId, sequence: root ? '0' : '1',
          parentRecordId: root ? null : 'root', memberOrdinal: '0', attempt: '0', contentRevision: '0',
          lifecycle: root ? variant === 'cancelled-root' ? 'cancelled' : variant === 'terminal-root' ? 'completed' : 'running'
            : variant === 'cancel-requested' ? 'cancel_requested' : 'waiting_for_approval',
          createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' });
        const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
          invocationPath: { blockId: root ? '$root' : 'review', scope: [] }, blockKind: root ? 'root' : 'step',
          attempt: '0', logicalInvocationRecordId: id,
          ...(!root ? { execution: { kind: 'action', actionId: 'discussion.invite',
            actionRequestId: `${slot}:discussion.invite`, localInputId: slot, input,
            output: { kind: 'approval_request_created', artifactId: 'approval', actionId: 'discussion.invite' } } } : {}),
        });
        return { index, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
          mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account', runId,
            recordId: id, sequence: index.sequence, parentRecordId: index.parentRecordId,
            memberOrdinal: index.memberOrdinal, attempt: index.attempt }, progress })) };
      };
      // Only the persistent Home boundary is substituted. All envelope opening,
      // accepted selection, principal checks, approval CAS and replay run for real.
      let rootReads = 0;
      let postClaimRunReads = 0;
      const custodyStorage = { execute: async (operation: WorkflowRunStorageOperation) => {
        if (operation.runId !== runId) return null;
        if (operation.operation === 'run-key.census') return census;
        if (operation.operation === 'get') {
          if (request.status === 'executing' && ++postClaimRunReads === 2 && variant === 'cancel-during-accepted-snapshot') {
            storage.requestControl('cancelled');
          }
          return storage.execute({ operation: 'get', runId });
        }
        if (operation.operation === 'invocations.get') {
          if (operation.invocationId === 'root' && rootReads === 1 && variant === 'cancel-before-final-root') {
            storage.requestControl('cancelled');
          }
          const captured = operation.invocationId === 'root' || operation.invocationId === 'invocation-1'
            ? row(String(operation.invocationId)) : null;
          if (captured && operation.invocationId === 'root') {
            rootReads++;
            if (storage.run().state === 'cancelled' && variant === 'cancel-before-final-root') {
              // The server cancellation owner advances the index lifecycle and
              // content revision without rewriting the sealed progress bytes.
              captured.index.lifecycle = 'cancel_requested';
              captured.index.contentRevision = '1';
            }
            if (rootReads === 2 && variant === 'cancel-after-final-root') storage.requestControl('cancelled');
          }
          return { invocation: captured };
        }
        throw new Error(`Unexpected storage operation: ${operation.operation}`);
      } };
      const unavailable = async (): Promise<never> => { throw new Error('Unexpected principal lookup'); };
      const principalCurrent = createWorkflowAcceptedAuthorizationCurrentness({ accountId: 'account',
        listAccountApiTokens: unavailable, resolveCurrentPluginOccurrenceId: unavailable,
        resolveCurrentPluginSourceCustody: unavailable, isMediatedSourceCurrent: unavailable,
        discussionModelReservationCustody: { storage: custodyStorage,
          resolveAccountEncryption: async () => ({ kind: 'available', witness: {
            mode: 'plain', version: 1, contentKeyFingerprint: null } }) },
      });
      const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'account', machineId: 'machine', serverId: 'home',
        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: 'srv_home' }),
        resolveTarget: async args => args.target, isAccountCurrent: async () => true, listAccountApiTokens: unavailable,
        isWorkflowRunAuthorizationCurrent: principalCurrent });
      const forged = structuredClone(request);
      const caller = forged.executionOriginV1.caller;
      if (caller.kind !== 'workflowRun' || !caller.discussionModelReservation) throw new Error('Missing marker');
      if (variant === 'missing-run' || variant === 'wrong-invocation') {
        if (variant === 'missing-run') caller.runId = 'NO_SUCH_ACCEPTED_RUN';
        const forgedSlot = `workflow:${caller.runId}:no-such-invocation`;
        caller.discussionModelReservation.participantSlotId = forgedSlot;
        forged.executionOriginV1.requestId = `${forgedSlot}:discussion.invite`;
        forged.actionArgs = { ...input, participant: { ...input.participant, participantSlotId: forgedSlot } };
      }
      if (variant === 'wrong-discussion') {
        caller.discussionModelReservation.discussionId = 'other-discussion';
        forged.actionArgs = { ...input, discussionId: 'other-discussion' };
      }
      if (variant === 'wrong-slot') {
        caller.discussionModelReservation.participantSlotId = 'outside-any-workflow';
        forged.actionArgs = { ...input, participant: { ...input.participant, participantSlotId: 'outside-any-workflow' } };
      }
      if (variant === 'wrong-request') forged.executionOriginV1.requestId = 'not-a-workflow-request';
      if (variant === 'wrong-launch') forged.actionArgs = { ...input, participant: { ...input.participant,
        launch: { ...launch, directory: { kind: 'path', path: '/other' } } } };
      if (variant === 'wrong-authorization') caller.authorization = { principal: { kind: 'session', sessionId: 'forged' },
        admittedPermissionCeiling: 'default' };
      request = ApprovalRequestV2Schema.parse(forged);
      let reservations = 0;
      let starts = 0;
      const executor = createActionExecutor({ isApprovalExecutionOriginCurrent: currentness,
        approvalsGet: async () => request,
        approvalsUpdate: async ({ request: next }) => {
          const transition = decideApprovalRequestTransition(request, next);
          if (transition.ok) request = ApprovalRequestV2Schema.parse(next);
          return transition;
        },
        discussionAction: async () => { reservations++; return { discussionId: 'discussion', ownerAccountId: 'account',
          access: 'owner', grants: [], changed: true, modelParticipant: { participant: { kind: 'model', participantSlotId: slot },
            launch, sessionId: null, answerPolicy: 'when_addressed', createdAt: 1 } }; },
        sessionSpawnNew: async () => { starts++; throw new Error('Workflow alone starts Sessions'); },
      });
      const result = await executor.replayApprovedApprovalRequest({ artifactId: 'approval', callerAuthority: 'present_user',
        currentAccount: { accountId: 'account', serverId: 'home', serverIdentityId: 'srv_home' } });
      expect(starts).toBe(0);
      if (variant === 'reclaim' || variant === 'cancel-after-final-root') {
        // INT-accepted residual: cancellation after the final read cannot guard
        // the invite HTTP effect. At most one removable orphan slot may remain;
        // it must never start a Session or be duplicated by approval replay.
        if (variant === 'cancel-after-final-root') expect(storage.run().state).toBe('cancelled');
        expect(result).toMatchObject({ ok: true });
        expect(reservations).toBe(1);
        expect(request.status).toBe('executed');
        await executor.replayApprovedApprovalRequest({ artifactId: 'approval', callerAuthority: 'present_user',
          currentAccount: { accountId: 'account', serverId: 'home', serverIdentityId: 'srv_home' } });
        expect(reservations).toBe(1);
        expect(starts).toBe(0);
      } else {
        expect(reservations).toBe(0);
        expect(request.status).toBe('failed');
        // Replay returns the decision receipt; its recorded execution owns the
        // typed refusal, independently of the receipt's successful persistence.
        expect(buildActionExecuteResultFromRecordedApprovalExecution(request))
          .toMatchObject({ ok: false, errorCode: 'approval_stale' });
      }
    });
});
