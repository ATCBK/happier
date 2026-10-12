import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openWorkflowCheckpointStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
  type WorkflowProgressEnvelopeV1, type WorkflowDefinitionV1,
} from '@happier-dev/protocol';
import * as scm from '@/scm/readWorktreeChangeFingerprint';
import { createProductionWorkflowRunCoordinator, type WorkflowProductionExecutionDeps } from './production';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const accountId = 'account-1';
const machineId = 'machine-1';
const rootRecordId = 'root-review';
const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId, nextSequence: '10',
  frontier: { nextBlockOrdinal: 1, paused: false } };
const serialize = (progress: Omit<WorkflowProgressEnvelopeV1, 'logicalInvocationRecordId'>, id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string) =>
  serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', progress: { ...progress, logicalInvocationRecordId: id },
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence, parentRecordId, memberOrdinal, attempt: '0' } }));

afterEach(() => vi.restoreAllMocks());

describe('workflow final-panel certification', () => {
  it.each([
    { last: 'F-b', expected: 'F-b', failedPanel: false, cancelled: false },
    { last: 'F-b', expected: 'F-b', failedPanel: false, cancelled: false, extraStoredFields: true },
    { last: 'F-b', expected: undefined, failedPanel: false, cancelled: false, extraStoredFields: true, invalidEngineOutcome: true },
    { last: 'F-c', expected: undefined, failedPanel: false, cancelled: false },
    { last: null, expected: undefined, failedPanel: false, cancelled: false },
    { last: 'F-b', expected: undefined, failedPanel: true, cancelled: false },
    { last: 'F-b', expected: undefined, failedPanel: false, cancelled: true },
    { last: 'F-b', expected: undefined, failedPanel: false, cancelled: false, materialization: { kind: 'partial', errorCode: 'write_failed' } },
    { last: 'F-b', expected: undefined, failedPanel: false, cancelled: false, materialization: { kind: 'failed', errorCode: 'write_failed' } },
    { last: 'F-b', expected: undefined, failedPanel: false, cancelled: false, materialization: null },
  ])('persists only the final reviewed tree after restart ($last; failed panel $failedPanel; cancelled $cancelled; materialization $materialization; retained extras $extraStoredFields; invalid outcome $invalidEngineOutcome)', async ({ last, expected, failedPanel, cancelled, materialization, extraStoredFields, invalidEngineOutcome }) => {
    // The current tree moved to F-d after the panel started. Closing the run
    // must use the persisted typed review values and never inspect that tree.
    const read = vi.spyOn(scm, 'readWorktreeChangeFingerprint').mockResolvedValue({ kind: 'available', fingerprint: 'F-d' });
    const definition: WorkflowDefinitionV1 = { version: 1,
      inputs: [{ name: 'diffFingerprint', valueType: 'string', required: false }], defaults: {},
      blocks: [{ kind: 'loop', id: 'rounds', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
        body: [{ kind: 'loop', id: 'panel', repetition: { kind: 'items', items: { kind: 'literal', value: ['a', 'b'] },
          execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [{ kind: 'action', id: 'review', actionId: 'review.start', input: {} }] }] }] };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: {
        definition, authoredDefinition: definition, startedBy: 'user', workDepth: 0, frozenChildren: {}, metadata: null,
        inputs: { diffFingerprint: 'F-a' }, machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
        materializedLeaves: [{ authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: 'review', kind: 'action', actionId: 'review.start',
          selection: {}, executionTarget: { kind: 'session' } }],
        source: { kind: 'automation', automationId: 'automation-1' }, origin: { kind: 'direct', originSessionId: 'origin' },
      } }));
    const boundary = createWorkflowRunStorageTestkit({ runId, machineId, acceptedEnvelope,
      origin: { kind: 'automation', automationId: 'automation-1' }, invocationPageSize: 1 });
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain', checkpoint,
      binding: { v: 1, purpose: 'checkpoint', accountId, runId } }));
    await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, parentAttempt: 0, accountCurrentness: witness,
      checkpointEnvelope, rootInvocation: { id: rootRecordId, contentEnvelope: serialize({ kind: 'happier.workflow-progress.v1',
        invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0' }, rootRecordId, '0', null, '0') } });
    const fingerprints = ['F-a', 'F-a', 'F-b', last];
    let nextSequence = 1;
    const admitCompleted = async (id: string, parentRecordId: string, memberOrdinal: string, progress: Omit<WorkflowProgressEnvelopeV1, 'logicalInvocationRecordId'>) => {
      const sequence = String(nextSequence++);
      await boundary.execute({ operation: 'invocations.admit', runId, parentAttempt: 0, accountCurrentness: witness,
        expectedRevision: boundary.run().revision, checkpointEnvelope,
        invocations: [{ id, sequence, parentRecordId, memberOrdinal,
          contentEnvelope: serialize(progress, id, sequence, parentRecordId, memberOrdinal) }] });
      const row = boundary.rowById(id)!;
      row.index = { ...row.index, lifecycle: 'completed' };
    };
    for (let index = 0; index < fingerprints.length; index++) {
      const id = `review-${index}`;
      const round = Math.floor(index / 2);
      const panelId = `panel-${round}`;
      const roundScope = [{ kind: 'iteration' as const, blockId: 'rounds', index: round }];
      const scope = [...roundScope, { kind: 'iteration' as const, blockId: 'panel', index: index % 2 }];
      if (index % 2 === 0) await admitCompleted(panelId, rootRecordId, String(round), {
        kind: 'happier.workflow-progress.v1', blockKind: 'loop', attempt: '0', invocationPath: { blockId: 'panel', scope: roundScope } });
      const itemId = `item-${index}`;
      await admitCompleted(itemId, panelId, String(index % 2), { kind: 'happier.workflow-progress.v1',
        blockKind: 'loop', attempt: '0', invocationPath: { blockId: 'panel', scope },
        frame: { ownerBlockId: 'panel', source: { kind: 'item', index: String(index % 2) } } });
      const failsBeforeLaunch = failedPanel && round === 1;
      await admitCompleted(id, itemId, '0', { kind: 'happier.workflow-progress.v1', blockKind: 'action', attempt: '0',
            invocationPath: { blockId: 'review', scope }, ...(failsBeforeLaunch ? {} : { execution: { kind: 'action', actionId: 'review.start',
              localInputId: id, actionRequestId: id, input: {} }, result: { reviewedFingerprint: fingerprints[index]!,
              ...(extraStoredFields ? { retiredReviewField: true } : {}),
              commentIds: [], perEngineOutcome: [{ key: `engine-${index % 2}`, outcome: invalidEngineOutcome ? 'retired_outcome' : 'completed',
                ...(extraStoredFields ? { retiredEngineField: true } : {}),
                ...(round === 1 && index % 2 === 1 && materialization !== undefined
                  ? materialization === null ? {} : { materialization }
                  : { materialization: { kind: 'complete', ...(extraStoredFields ? { retiredMaterializationField: true } : {}) } }) }] } }),
          });
      if (failsBeforeLaunch) boundary.rowById(id)!.index = { ...boundary.rowById(id)!.index, lifecycle: 'failed' };
    }
    if (cancelled) boundary.requestControl('cancel_requested');
    const execution: WorkflowProductionExecutionDeps = { credentials: { token: 'token', encryption: null }, serverId: 'server',

      machineAdmissionTransport: async () => { throw new Error('Completed frontier cannot send input'); },
      resolveExistingSessionConversation: async () => { throw new Error('Completed frontier cannot start a conversation'); },
      detachedRun: { actionExecutor: { execute: async () => { throw new Error('Completed frontier cannot start native work'); } },
        buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) } };
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage: boundary,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      execution, resolveAccountEncryption: async () => ({ kind: 'available', witness }),
      isAcceptedAuthorizationCurrent: async () => true, onCommittedTransition: () => {} });
    await expect(coordinate({ runId, attempt: 0, expectedRevision: boundary.run().revision, accountCurrentness: witness, acceptedEnvelope }))
      .resolves.toMatchObject({ state: cancelled ? 'cancelled' : 'succeeded' });
    const opened = openWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, envelope: parseWorkflowStoredContentEnvelopeV1(boundary.checkpointEnvelope()) });
    expect(opened.kind).toBe('available');
    if (opened.kind !== 'available') throw new Error('Closing checkpoint unavailable');
    expect('endFingerprint' in opened.content ? opened.content.endFingerprint : undefined).toBe(expected);
    if (extraStoredFields) {
      const retained = boundary.rowById('review-3')!;
      const index = retained.index;
      expect(openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: index.id,
          sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt },
        envelope: parseWorkflowStoredContentEnvelopeV1(retained.contentEnvelope),
      })).toMatchObject({ kind: 'available', content: { result: { retiredReviewField: true,
        perEngineOutcome: [{ retiredEngineField: true, materialization: { retiredMaterializationField: true } }] } } });
    }
    expect(read).not.toHaveBeenCalled();
  });
});
