import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';
import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from './workflowRunActions.js';
import { WorkflowInvocationGetResultV1Schema, WorkflowInvocationListRequestV1Schema, WorkflowInvocationRetryResultV1Schema } from '../../workflows/actionsV1.js';
import { DEBATE_WORKFLOW_V1 } from '../../workflows/builtins/debate.js';
import { materializeWorkflowAcceptedSnapshotV1 } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { WorkflowProgressEnvelopeV1Schema, WorkflowRunInvocationIndexV1Schema, WorkflowRunSummaryV1Schema } from '../../workflows/workflowProgressV1.js';
import { openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '../../workflows/workflowStoredContentV1.js';
import { WorkflowRunRecipientCensusResponseV1Schema } from '../../workflows/workflowRunKeyV1.js';
import { WorkflowDiscussionRoundProjectResultV1Schema } from '../../workflows/workflowDiscussionRoundV1.js';
import type { ActionExecutorContext } from './types.js';
import type { WorkflowBlock, WorkflowDefinitionV1 } from '../../workflows/workflowV1.js';
import { resolveActionCurrentSessionScopeFailure } from './sessionListAccess.js';

const runId = '11111111-1111-4111-8111-111111111111';

type ConditionalShape = 'collection-in-if' | 'projector-in-if';

const participantCount = process.env.HAPPIER_WORKFLOW_SCALE_MEASUREMENT === '1' ? 500 : 24;

async function fixture(conditionalShape?: ConditionalShape, participantCount = 2, consumer: 'round' | 'review' = 'round', framePath?: 'item' | 'parallel' | 'workflow') {
  const conditional = (id: string, blocks: WorkflowBlock[]): WorkflowBlock => ({ kind: 'if', id,
    when: { kind: 'compare', operator: 'eq', left: { kind: 'literal', value: true }, right: { kind: 'literal', value: true } },
    then: blocks, otherwise: [] });
  let definition: WorkflowDefinitionV1 = conditionalShape ? { ...DEBATE_WORKFLOW_V1,
    blocks: DEBATE_WORKFLOW_V1.blocks.map(block => block.kind === 'loop' ? { ...block,
      body: block.body.flatMap(child => conditionalShape === 'collection-in-if' && child.kind === 'loop'
        && child.id === 'speakers' && child.repetition.kind === 'items' && child.repetition.items.kind === 'result'
        ? [conditional('conditional-speakers', [{ ...child,
          repetition: { ...child.repetition, items: { ...child.repetition.items,
            producer: { ...child.repetition.items.producer, scope: { kind: 'outer', levels: 1 } } } },
          body: child.body.map(reply => reply.kind === 'step' ? { ...reply, input: reply.input.map(reference =>
            reference.kind === 'result' && reference.producer.blockId === 'context'
              ? { ...reference, producer: { ...reference.producer, scope: { kind: 'outer', levels: 2 } } } : reference) } : reply),
        }])]
        : conditionalShape === 'projector-in-if' && child.kind === 'action' && child.id === 'outcomes'
          ? [child, conditional('conditional-outcomes', [{ ...child, id: 'nested-outcomes' }])]
          : [child]),
    } : block),
  } : DEBATE_WORKFLOW_V1;
  const address = { serverId: 'home', sessionId: 'review-target' };
  if (consumer === 'review') {
    const replace = (blocks: WorkflowBlock[]): WorkflowBlock[] => blocks.map(block => {
      if (block.kind === 'action' && (block.id === 'outcomes' || block.id === 'nested-outcomes')) return {
        ...block, actionId: 'reviews.comments.list', input: { sessionId: { kind: 'input', name: 'reviewSession', path: ['sessionId'] } },
      };
      if (block.kind === 'if') return { ...block, then: replace(block.then), otherwise: replace(block.otherwise) };
      if (block.kind === 'loop') return { ...block, body: replace(block.body) };
      return block;
    });
    definition = { ...definition, inputs: [...definition.inputs, { name: 'reviewSession', valueType: 'json', required: true,
      inputType: { hostType: 'session' } }], blocks: replace(definition.blocks) };
  }
  const childDefinition = definition;
  if (framePath === 'item') definition = { ...definition, blocks: [{ kind: 'loop', id: 'panels',
    repetition: { kind: 'items', items: { kind: 'literal', value: ['panel'] }, execution: 'sequential', failurePolicy: 'fail_stop' }, body: definition.blocks }],
    finalOutput: { kind: 'result', producer: { blockId: 'panels', scope: { kind: 'current' } }, path: [] } };
  if (framePath === 'parallel') definition = { ...definition, blocks: [{ kind: 'parallel', id: 'panels', failurePolicy: 'fail_stop',
    branches: [{ id: 'panel', blocks: definition.blocks }] }],
    finalOutput: { kind: 'result', producer: { blockId: 'panels', scope: { kind: 'current' } }, path: [] } };
  if (framePath === 'workflow') definition = { ...definition, blocks: [{ kind: 'workflow', id: 'panel', workflowRef: 'builtin:debate',
    input: Object.fromEntries(definition.inputs.filter(input => input.required).map(input => [input.name, { kind: 'input' as const, name: input.name }])) }],
    finalOutput: { kind: 'result', producer: { blockId: 'panel', scope: { kind: 'current' } }, path: [] } };
  const participants = Array.from({ length: participantCount }, (_, index) => ({ kind: 'session' as const,
    session: { serverId: 'home', sessionId: `participant-${index}` } }));
  const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
    context: { source: { kind: 'inline' }, inputs: { question: 'Review this change', participants, rounds: 3,
      ...(consumer === 'review' ? { reviewSession: address } : {}) }, machineId: 'machine-a',
      executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true,
      readWorkflowDefinition: async () => ({ definition: childDefinition, sourceKey: 'builtin:debate' }),
      resolveSessionTarget: async value => {
        if ((value as { sessionId?: string }).sessionId === address.sessionId) return { address, machineId: 'machine-a' };
        const participant = participants.find(participant => participant.session.sessionId === (value as { sessionId?: string }).sessionId);
        return participant ? { address: participant.session, machineId: 'machine-a' } : null;
      }, readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }) } });
  if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
  const rows: { index: ReturnType<typeof WorkflowRunInvocationIndexV1Schema.parse>;
    progress: ReturnType<typeof WorkflowProgressEnvelopeV1Schema.parse>; contentEnvelope: string }[] = [];
  const seal = (row: typeof rows[number]) => {
    row.contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: row.index.id,
        sequence: row.index.sequence, parentRecordId: row.index.parentRecordId, memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt },
      progress: row.progress }));
  };
  const row = (id: string) => {
    const found = rows.find(row => row.index.id === id);
    if (!found) throw new Error(`Missing fixture row: ${id}`);
    return found;
  };
  const add = (parentRecordId: string | null, memberOrdinal: number,
    progress: Omit<ReturnType<typeof WorkflowProgressEnvelopeV1Schema.parse>, 'kind' | 'attempt' | 'logicalInvocationRecordId'>,
    previousId?: string) => {
    const id = `22222222-2222-4222-8222-${String(rows.length).padStart(12, '0')}`;
    const previous = previousId ? row(previousId) : undefined;
    const attempt = previous ? String(BigInt(previous.index.attempt) + 1n) : '0';
    const index = WorkflowRunInvocationIndexV1Schema.parse({ id, runId, parentRecordId, memberOrdinal: String(memberOrdinal),
      sequence: String(rows.length), attempt, contentRevision: '0', lifecycle: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const added = { index, progress: WorkflowProgressEnvelopeV1Schema.parse({ ...progress, kind: 'happier.workflow-progress.v1',
      attempt, logicalInvocationRecordId: previous?.progress.logicalInvocationRecordId ?? id,
      ...(previousId ? { previousAttemptRecordId: previousId } : {}) }), contentEnvelope: '' };
    rows.push(added);
    seal(added);
    return id;
  };
  const recover = (id: string, parentRecordId = row(id).index.parentRecordId) => {
    const previous = row(id);
    previous.index.lifecycle = 'superseded';
    return add(parentRecordId, Number(previous.index.memberOrdinal), previous.progress, id);
  };
  const move = (id: string, parentRecordId: string) => {
    const moved = row(id);
    moved.index.parentRecordId = parentRecordId;
    seal(moved);
  };
  const root = add(null, 0, { blockKind: 'root', invocationPath: { blockId: '$root', scope: [] } });
  const outerScope = framePath === 'item' ? [{ kind: 'iteration' as const, blockId: 'panels', index: 0 }]
    : framePath === 'parallel' ? [{ kind: 'branch' as const, blockId: 'panels', branchId: 'panel' }]
      : framePath === 'workflow' ? [{ kind: 'workflow' as const, blockId: 'panel' }] : [];
  const outerLoop = framePath === 'item' ? add(root, 0, { blockKind: 'loop', invocationPath: { blockId: 'panels', scope: [] },
    container: { kind: 'loop', mode: 'items', source: { kind: 'definition', reference: { kind: 'literal', value: ['panel'] } },
      itemCount: '1', nextMemberIndex: '1', nextBodyBlockOrdinal: '0' } })
    : framePath === 'parallel' ? add(root, 0, { blockKind: 'parallel', invocationPath: { blockId: 'panels', scope: [] },
      container: { kind: 'parallel', nextBranchOrdinal: '1' } }) : root;
  const outerFrame = framePath === 'item' ? add(outerLoop, 0, { blockKind: 'loop', invocationPath: { blockId: 'panels', scope: outerScope },
    frame: { ownerBlockId: 'panels', source: { kind: 'item', index: '0' } } })
    : framePath === 'parallel' ? add(outerLoop, 0, { blockKind: 'parallel', invocationPath: { blockId: 'panels', scope: outerScope },
      frame: { ownerBlockId: 'panels', source: { kind: 'branch', branchId: 'panel' } } })
      : framePath === 'workflow' ? add(root, 0, { blockKind: 'workflow', invocationPath: { blockId: 'panel', scope: [] },
        container: { kind: 'body', nextBlockOrdinal: '1', frameInputs: { question: 'Review this change', participants, rounds: 3,
          ...(consumer === 'review' ? { reviewSession: address } : {}) } } }) : root;
  const loop = add(outerFrame, 0, { blockKind: 'loop', invocationPath: { blockId: 'rounds', scope: outerScope },
    container: { kind: 'loop', mode: 'until', nextMemberIndex: '3', nextBodyBlockOrdinal: '0' } });
  const rounds = [];
  for (let round = 0; round < 3; round += 1) {
    const scope = [...outerScope, { kind: 'iteration' as const, blockId: 'rounds', index: round }];
    const frame = add(loop, round, { blockKind: 'loop', invocationPath: { blockId: 'rounds', scope },
      frame: { ownerBlockId: 'rounds', source: { kind: 'iteration', index: String(round) } } });
    const result = WorkflowDiscussionRoundProjectResultV1Schema.parse({ allPassed: false, hasNext: true,
      nextParticipants: participants, outcomeReferences: [], throughSeq: round + 1 });
    const prepare = add(frame, 0, { blockKind: 'action', invocationPath: { blockId: 'context', scope }, result });
    const collectionParent = conditionalShape === 'collection-in-if'
      ? add(frame, 1, { blockKind: 'if', invocationPath: { blockId: 'conditional-speakers', scope }, container: { kind: 'if', selected: 'then', nextBlockOrdinal: '1' } })
      : frame;
    const collection = add(collectionParent, conditionalShape === 'collection-in-if' ? 0 : 1, { blockKind: 'loop', invocationPath: { blockId: 'speakers', scope },
      container: { kind: 'loop', mode: 'items', source: { kind: 'result', recordId: prepare, path: ['nextParticipants'] },
        itemCount: String(participants.length), nextMemberIndex: String(participants.length), nextBodyBlockOrdinal: '0' } });
    const replies = [];
    const itemFrames: string[] = [];
    for (let item = 0; item < participants.length; item += 1) {
      const itemScope = [...scope, { kind: 'iteration' as const, blockId: 'speakers', index: item }];
      const itemFrame = add(collection, item, { blockKind: 'loop', invocationPath: { blockId: 'speakers', scope: itemScope },
        frame: { ownerBlockId: 'speakers', source: { kind: 'item', index: String(item) } } });
      itemFrames.push(itemFrame);
      const reply = { kind: 'answer' as const, result: { sessionId: participants[item]!.session.sessionId, messageId: `answer-${round}-${item}` } };
      const id = add(itemFrame, 0, { blockKind: 'step', invocationPath: { blockId: 'reply', scope: itemScope }, replyOutcome: reply, result: `answer ${item}` });
      replies.push({ runId, invocationRecordId: id, participant: participants[item]!, kind: 'answer' as const, result: `answer ${item}`, reply });
    }
    let complete = add(frame, 2, { blockKind: 'action', invocationPath: { blockId: 'outcomes', scope }, result: { ...result, outcomeReferences: replies } });
    if (conditionalShape === 'projector-in-if') {
      const projectorParent = add(frame, 3, { blockKind: 'if', invocationPath: { blockId: 'conditional-outcomes', scope }, container: { kind: 'if', selected: 'then', nextBlockOrdinal: '1' } });
      complete = add(projectorParent, 0, { blockKind: 'action', invocationPath: { blockId: 'nested-outcomes', scope } });
    }
    rounds.push({ frame, prepare, collectionParent, collection, complete, itemFrames, replies });
  }
  const run = WorkflowRunSummaryV1Schema.parse({ id: runId, sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
    origin: { kind: 'direct' }, state: 'running', revision: 0, machineId: 'machine-a', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
    availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const snapshot = { run, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: accepted.snapshot })), checkpointEnvelope: null as string | null, resultEnvelope: null,
    keyCensus: WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: 'account-1', visibleTeamId: null, encryptionMode: 'plain', access: 'owner',
      ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] }) };
  const cost = { requests: 0, pages: 0, historyPages: 0, envelopes: 0, bytes: 0 };
  let miswire = false;
  let miswireChildren = false;
  const owner = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => 'account-1',
    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    definitions: { get: async () => { throw new Error('No mutable definition read'); } },
    normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
    storage: { execute: async operation => {
      cost.requests += 1;
      if (operation.operation === 'get') return snapshot;
      if (operation.operation === 'invocations.get') return { invocation: { ...row(String(operation.invocationId)), parentRevision: run.revision } };
      if (operation.operation === 'invocations.recover') {
        // Substitute only persistence: all replacement identities, progress and
        // envelopes are produced by the real retry Action above this boundary.
        const replacements = operation.recoveries as Array<{ invocationId: string; newInvocationId: string; contentEnvelope: string }>;
        const replacementIds = new Map(replacements.map(item => [item.invocationId, item.newInvocationId]));
        for (const item of replacements) {
          const previous = row(item.invocationId);
          const index = WorkflowRunInvocationIndexV1Schema.parse({ ...previous.index, id: item.newInvocationId,
            parentRecordId: replacementIds.get(previous.index.parentRecordId!) ?? previous.index.parentRecordId,
            sequence: String(rows.length), attempt: String(BigInt(previous.index.attempt) + 1n), lifecycle: 'pending' });
          const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: parseWorkflowStoredContentEnvelopeV1(item.contentEnvelope)!,
            binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId: index.id,
              sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: index.memberOrdinal, attempt: index.attempt } });
          if (opened.kind !== 'available') throw new Error('retry_producer_envelope_invalid');
          previous.index.lifecycle = 'superseded';
          rows.push({ index, progress: WorkflowProgressEnvelopeV1Schema.parse(opened.content), contentEnvelope: item.contentEnvelope });
        }
        run.revision += 1;
        run.state = 'queued';
        snapshot.checkpointEnvelope = String(operation.checkpointEnvelope);
        return { run, invocations: replacements.map(item => row(item.newInvocationId).index), disposition: 'accepted' };
      }
      if (operation.operation !== 'invocations.list') throw new Error('Unexpected storage operation');
      cost.pages += 1;
      const input = WorkflowInvocationListRequestV1Schema.parse({ runId, ...(operation.invocationId === undefined ? {} : { invocationId: operation.invocationId }),
        ...(operation.parentRecordIds === undefined ? {} : { parentRecordIds: operation.parentRecordIds }),
        ...(operation.parentRecordId === undefined ? {} : { parentRecordId: operation.parentRecordId }),
        ...(operation.memberOrdinal === undefined ? {} : { memberOrdinal: operation.memberOrdinal }) });
      if (input.invocationId === undefined && input.parentRecordId === undefined && input.parentRecordIds === undefined) cost.historyPages += 1;
      let selected = miswire || (miswireChildren && input.parentRecordIds) ? rows.slice(0, 1) : rows.filter(row => (!input.invocationId || row.index.id === input.invocationId)
        && (input.parentRecordId === undefined || row.index.parentRecordId === input.parentRecordId)
        && (!input.parentRecordIds || row.index.parentRecordId !== null && input.parentRecordIds.includes(row.index.parentRecordId))
        && (input.memberOrdinal === undefined || row.index.memberOrdinal === input.memberOrdinal));
      if (!miswire && input.memberOrdinal !== undefined) selected = selected.sort((left, right) =>
        Number(BigInt(right.index.attempt) - BigInt(left.index.attempt))).slice(0, 1);
      // Deliberately small transport pages exercise cursor traversal, not a product cap.
      const start = Number(operation.cursor ?? 0);
      const page = selected.slice(start, start + 100);
      if (operation.progressEnvelopes === true) {
        cost.envelopes += page.length;
        cost.bytes += page.reduce((sum, row) => sum + Buffer.byteLength(row.contentEnvelope), 0);
      }
      return { invocations: page.map(row => row.index), parentRevision: run.revision, keyCensus: snapshot.keyCensus,
        ...(start + page.length < selected.length ? { nextCursor: String(start + page.length) } : {}),
        ...(operation.progressEnvelopes === true ? { progressEnvelopesByInvocationId: Object.fromEntries(page.map(row => [row.index.id, row.contentEnvelope])) } : {}) };
    } },
  } satisfies WorkflowAccountRunActionDeps);
  const deps = { workflowAction: (args: Parameters<typeof owner.execute>[0]) => owner.execute(args),
    resolveSessionReference: async () => ({ kind: 'unique' as const, address }) };
  const executor = createActionExecutor(deps);
  const context = (id: string): ActionExecutorContext => ({ surface: 'agent', serverId: 'home',
    actionRequestId: `${runId}/${row(id).progress.logicalInvocationRecordId}/${row(id).index.attempt}`,
    actionCaller: { kind: 'workflowRun', runId, authorization: accepted.snapshot.authorization } });
  let currentRoot = root;
  const inspect = async (id: string) => WorkflowInvocationGetResultV1Schema.parse(await owner.execute({
    actionId: 'workflow.run.invocations.get', input: { runId, invocationId: id },
    context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' } }));
  const requestRetry = (id: string, causalInvocationIds: string[]) => owner.execute({
    actionId: 'workflow.run.invocations.retry', input: { runId, invocation: { recordId: id },
      expectedRevision: run.revision, causalInvocationIds, conversation: 'fresh_conversation', input: { kind: 'original' } },
    context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' } });
  const retry = async (id: string, recoverParent: boolean | 'ancestors' | 'root' = false) => {
    const failed = row(id);
    failed.index.lifecycle = failed.index.parentRecordId === null ? 'needs_attention' : 'failed';
    if (recoverParent === true) {
      const parent = row(failed.index.parentRecordId!);
      parent.index.lifecycle = 'failed';
      if (parent.progress.blockKind === 'loop' || parent.progress.blockKind === 'parallel') {
        failed.progress.reason = { code: `container_fail_stop:${parent.index.id}` };
      }
      seal(parent);
    }
    if (recoverParent === 'ancestors' || recoverParent === 'root') {
      let parentId = failed.index.parentRecordId;
      while (parentId !== null) {
        const parent = row(parentId);
        if (parent.index.parentRecordId !== null || recoverParent === 'root') {
          parent.index.lifecycle = parent.index.parentRecordId === null ? 'needs_attention' : 'failed';
          seal(parent);
        }
        parentId = parent.index.parentRecordId;
      }
    }
    seal(failed);
    run.state = 'interrupted';
    snapshot.checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId: 'account-1', runId }, checkpoint: {
        kind: 'happier.workflow-checkpoint.v1', rootRecordId: currentRoot, nextSequence: String(rows.length),
        frontier: { nextBlockOrdinal: 0, paused: false } } }));
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' };
    const detail = WorkflowInvocationGetResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.invocations.get',
      input: { runId, invocationId: id }, context }));
    const availability = detail.invocation.recoveryAvailability?.retry;
    if (availability?.kind !== 'available') throw new Error(`retry_unavailable:${JSON.stringify(availability)}`);
    const result = WorkflowInvocationRetryResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.invocations.retry',
      input: { runId, invocation: { recordId: id }, expectedRevision: run.revision,
        causalInvocationIds: availability.causalInvocationIds, conversation: 'fresh_conversation', input: { kind: 'original' } }, context }));
    expect(result.disposition).toBe('accepted');
    currentRoot = rows.find(item => item.index.parentRecordId === null && item.index.lifecycle !== 'superseded')!.index.id;
    Object.assign(cost, { requests: 0, pages: 0, historyPages: 0, envelopes: 0, bytes: 0 });
    return result.invocation.id;
  };
  return { cost, executor, context, rounds, recover, retry, inspect, requestRetry, move, row, seal, root, deps, address,
    interrupt: () => { run.state = 'interrupted'; },
    currentRoot: () => currentRoot,
    retainOriginalCheckpointRoot: () => {
      snapshot.checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'checkpoint', accountId: 'account-1', runId }, checkpoint: {
          kind: 'happier.workflow-checkpoint.v1', rootRecordId: root, nextSequence: String(rows.length),
          frontier: { nextBlockOrdinal: 0, paused: false } } }));
    },
    omit: (id: string) => { rows.splice(rows.indexOf(row(id)), 1); }, miswire: () => { miswire = true; },
    miswireChildren: () => { miswireChildren = true; } };
}

describe('Discussion round projection demand', () => {
  it('keeps an original-parent failed descendant retryable', async () => {
    const f = await fixture('projector-in-if');
    await expect(f.retry(f.rounds[2]!.complete)).resolves.toEqual(expect.any(String));
  });

  it.each(['root', 'intermediate', 'intermediate-failed'] as const)('retries an inherited child after %s-only recovery', async ancestor => {
    const f = await fixture('projector-in-if');
    const action = f.rounds[2]!.complete;
    f.row(action).index.lifecycle = 'pending';
    const currentParent = await f.retry(ancestor === 'root' ? f.currentRoot() : f.row(action).index.parentRecordId!);
    await expect(f.executor.execute('workflow.discussion.round.project',
      { collections: ['speakers'], preparationBlockId: 'context' }, f.context(action)))
      .resolves.toMatchObject({ ok: true, result: { throughSeq: 3, outcomeReferences: f.rounds[2]!.replies } });
    expect(f.cost.historyPages).toBe(0);
    if (ancestor === 'intermediate-failed') f.row(currentParent).index.lifecycle = 'failed';
    const replacement = await f.retry(action);
    if (ancestor === 'intermediate-failed') expect(f.row(currentParent).index.lifecycle).toBe('superseded');
    expect(f.row(action).index.lifecycle).toBe('superseded');
    await expect(f.executor.execute('workflow.discussion.round.project',
      { collections: ['speakers'], preparationBlockId: 'context' }, f.context(replacement)))
      .resolves.toMatchObject({ ok: true, result: { throughSeq: 3, outcomeReferences: f.rounds[2]!.replies } });
    expect(f.cost.historyPages).toBe(0);
    f.interrupt();
    expect((await f.inspect(action)).invocation.recoveryAvailability?.retry)
      .toMatchObject({ kind: 'unavailable', reason: 'invocation_not_recoverable' });
    await expect(f.requestRetry(action, [replacement])).rejects.toMatchObject({ code: 'ineligible_state' });
    // A valid producer result cannot authorize an unrelated transport row.
    f.miswire();
    await expect(f.executor.execute('workflow.discussion.round.project',
      { collections: ['speakers'] }, f.context(replacement)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it.each([false, true])('retains complete fail-stop closure and its completed neighbor (root recovered: %s)', async recoveredRoot => {
    const f = await fixture(undefined, 2, 'round', 'parallel');
    const action = f.rounds[2]!.complete;
    const stoppedSibling = f.rounds[0]!.complete;
    const completedNeighbor = f.rounds[1]!.complete;
    if (recoveredRoot) {
      f.row(action).index.lifecycle = 'pending';
      f.row(stoppedSibling).index.lifecycle = 'pending';
      await f.retry(f.currentRoot());
    }
    let group = f.row(action);
    while (group.progress.blockKind !== 'parallel' || group.progress.frame) group = f.row(group.index.parentRecordId!);
    const groupId = group.index.id;
    for (const id of [action, stoppedSibling]) {
      let row = f.row(id);
      row.progress.reason = { code: `container_fail_stop:${groupId}` };
      row.index.lifecycle = id === action ? 'failed' : 'cancelled';
      f.seal(row);
      while (row.index.id !== groupId) {
        row = f.row(row.index.parentRecordId!);
        row.index.lifecycle = 'needs_attention';
        f.seal(row);
      }
    }
    await expect(f.retry(action)).resolves.toEqual(expect.any(String));
    expect(f.row(stoppedSibling).index.lifecycle).toBe('superseded');
    expect(f.row(groupId).index.lifecycle).toBe('superseded');
    expect(f.row(completedNeighbor).index.lifecycle).toBe('completed');
    expect(f.row(f.currentRoot()).index.lifecycle).toBe(recoveredRoot ? 'pending' : 'completed');
  });

  const retryShapes = [
    { name: 'leaf only', shape: false },
    { name: 'one intermediate', shape: true },
    { name: 'all intermediates', shape: 'ancestors' },
    { name: 'root and intermediates', shape: 'root' },
    { name: 'root only', shape: 'root-only' },
    { name: 'selected IF and loop/item frames', shape: 'root', framePath: 'item' },
    { name: 'parallel branch frames', shape: 'root', framePath: 'parallel' },
    { name: 'inline Workflow frames', shape: 'root', framePath: 'workflow' },
    { name: 'root only after Action retry', shape: 'root-only', afterAction: true },
    { name: 'persisted original checkpoint root', shape: 'root', legacyCheckpoint: true },
    { name: 'persisted original checkpoint root only', shape: 'root-only', legacyCheckpoint: true },
  ] as const;
  it.each(retryShapes.flatMap(shape => (['round', 'review'] as const).map(consumer => ({ ...shape, consumer }))))
  ('binds producer retries: $name / $consumer', async ({ shape, consumer, ...options }) => {
    const f = await fixture('projector-in-if', 2, consumer, 'framePath' in options ? options.framePath : undefined);
    const round = f.rounds[2]!;
    let action = round.complete;
    if ('afterAction' in options) action = await f.retry(action);
    const check = async () => {
      if (consumer === 'round') {
        await expect(f.executor.execute('workflow.discussion.round.project',
          { collections: ['speakers'], preparationBlockId: 'context' }, f.context(action)))
          .resolves.toMatchObject({ ok: true, result: { allPassed: false, hasNext: true,
            throughSeq: 3, outcomeReferences: round.replies } });
      } else {
        await expect(resolveActionCurrentSessionScopeFailure('reviews.comments.list', { sessionId: f.address.sessionId },
          f.context(action), { sessionId: 'current_session' }, f.deps)).resolves.toBeNull();
      }
      expect(f.cost.historyPages).toBe(0);
    };
    for (let depth = 0; depth < 2; depth += 1) {
      if (shape === 'root-only') await f.retry(f.currentRoot());
      else action = await f.retry(action, shape);
      if ('legacyCheckpoint' in options) f.retainOriginalCheckpointRoot();
      await check();
    }
    // A later producer-created parent-only recovery must inherit the Action.
    if (shape !== 'root-only') {
      await f.retry(f.row(action).index.parentRecordId!);
      await check();
    }
    // A transport returning a different slot must not turn successful binding
    // into permission to use unrelated progress.
    f.miswire();
    if (consumer === 'round') await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, f.context(action)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    else await expect(resolveActionCurrentSessionScopeFailure('reviews.comments.list', { sessionId: f.address.sessionId },
      f.context(action), { sessionId: 'current_session' }, f.deps)).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it.each((['root', 'root-predecessor', 'run'] as const).flatMap(field => (['round', 'review'] as const).map(consumer => ({ field, consumer }))))
  ('refuses producer-created root replacement with misbound $field / $consumer', async ({ field, consumer }) => {
    const f = await fixture(undefined, 2, consumer);
    const action = await f.retry(f.rounds[2]!.complete, 'root');
    const context = f.context(action);
    if (field === 'root' || field === 'root-predecessor') {
      if (field === 'root') f.row(f.currentRoot()).progress.logicalInvocationRecordId = f.rounds[0]!.frame;
      else f.row(f.currentRoot()).progress.previousAttemptRecordId = f.rounds[0]!.frame;
      f.seal(f.row(f.currentRoot()));
    } else if (context.actionCaller?.kind === 'workflowRun') context.actionCaller = { ...context.actionCaller,
      runId: '99999999-9999-4999-8999-999999999999' };
    if (consumer === 'round') await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    else await expect(resolveActionCurrentSessionScopeFailure('reviews.comments.list', { sessionId: f.address.sessionId },
      context, { sessionId: 'current_session' }, f.deps)).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(f.cost.historyPages).toBe(0);
  });

  it.each(['logical', 'attempt', 'run', 'envelope'] as const)('refuses a recovered projector with wrong %s binding', async field => {
    const f = await fixture();
    const round = f.rounds[2]!;
    const action = await f.retry(round.complete, true);
    const context = f.context(action);
    if (field === 'logical') context.actionRequestId = `${runId}/${round.prepare}/1`;
    if (field === 'attempt') context.actionRequestId = `${runId}/${round.complete}/2`;
    if (field === 'run' && context.actionCaller?.kind === 'workflowRun') context.actionCaller = {
      ...context.actionCaller, runId: '99999999-9999-4999-8999-999999999999' };
    if (field === 'envelope') f.row(action).contentEnvelope = f.row(round.prepare).contentEnvelope;
    await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(f.cost.historyPages).toBe(0);
  });
  it('inherits committed collection and preparation from a recovered round frame', async () => {
    const f = await fixture();
    const round = f.rounds[2]!;
    const frame = f.recover(round.frame);
    f.move(round.complete, frame);
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], preparationBlockId: 'context' }, f.context(round.complete));
    expect(result).toMatchObject({ ok: true, result: { allPassed: false, hasNext: true, throughSeq: 3,
      outcomeReferences: round.replies } });
    expect(f.cost.historyPages).toBe(0);
    // Keep admission/ancestry intact, then mis-bind only the batched recovery
    // descendant reader. A successful empty projection must not hide it.
    f.miswireChildren();
    await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], preparationBlockId: 'context' }, f.context(round.complete)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it('retains committed answers through successive recovered participant frames', async () => {
    const f = await fixture(undefined, 24);
    const round = f.rounds[2]!;
    for (const frame of round.itemFrames) f.recover(f.recover(frame));
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], preparationBlockId: 'context' }, f.context(round.complete));
    expect(result).toMatchObject({ ok: true, result: { allPassed: false, hasNext: true, outcomeReferences: round.replies } });
    expect(f.cost.historyPages).toBe(0);
    // Recovery depth adds batched levels, never one request per participant.
    expect(f.cost.requests).toBeLessThan(30);
  });

  it('masks inherited answers with replacement and skipped slots without double counting', async () => {
    const f = await fixture();
    const round = f.rounds[2]!;
    const replacementReplies: string[] = [];
    for (const [index, frame] of round.itemFrames.entries()) {
      const replacement = f.recover(frame);
      const reply = f.row(f.recover(round.replies[index]!.invocationRecordId, replacement));
      if (index === 0) reply.index.lifecycle = 'skipped';
      else reply.progress.replyOutcome = { kind: 'pass' };
      f.seal(reply);
      if (index !== 0) replacementReplies.push(reply.index.id);
    }
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, f.context(round.complete));
    expect(result).toMatchObject({ ok: true, result: { allPassed: true, hasNext: false,
      outcomeReferences: [{ invocationRecordId: replacementReplies[0], kind: 'pass' }] } });
    if (!result.ok) throw new Error('Projection unavailable');
    expect(WorkflowDiscussionRoundProjectResultV1Schema.parse(result.result).outcomeReferences).toHaveLength(1);
  });

  it('prepares from the inherited preceding round projection', async () => {
    const f = await fixture();
    f.recover(f.recover(f.rounds[1]!.frame));
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], phase: 'prepare',
      rosterInput: 'participants', previousProjectionBlockId: 'outcomes' }, f.context(f.rounds[2]!.prepare));
    expect(result).toMatchObject({ ok: true, result: { throughSeq: 2, hasNext: true, outcomeReferences: f.rounds[1]!.replies } });
    expect(f.cost.historyPages).toBe(0);
  });

  it('inherits the selected IF branch after structural recovery', async () => {
    const f = await fixture('collection-in-if');
    f.recover(f.recover(f.rounds[2]!.collectionParent));
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], preparationBlockId: 'context' }, f.context(f.rounds[2]!.complete));
    expect(result).toMatchObject({ ok: true, result: { allPassed: false, hasNext: true, outcomeReferences: f.rounds[2]!.replies } });
  });

  it('fails closed when an inherited parent is unavailable', async () => {
    const f = await fixture();
    const round = f.rounds[2]!;
    f.recover(round.itemFrames[0]!);
    f.omit(round.itemFrames[0]!);
    await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, f.context(round.complete)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it('does not treat a missing nonempty collection history as all passed', async () => {
    const f = await fixture();
    const round = f.rounds[2]!;
    for (const id of round.itemFrames) f.omit(id);
    await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, f.context(round.complete)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });

  it('accepts an empty outcome set only after reading a genuinely empty collection', async () => {
    const f = await fixture();
    const round = f.rounds[2]!;
    for (const id of round.itemFrames) f.omit(id);
    const collection = f.row(round.collection);
    if (collection.progress.container?.kind !== 'loop' || collection.progress.container.mode !== 'items') throw new Error('Not an item collection');
    collection.progress.container.itemCount = '0';
    collection.progress.container.nextMemberIndex = '0';
    f.seal(collection);
    const preparation = f.row(round.prepare);
    preparation.progress.result = WorkflowDiscussionRoundProjectResultV1Schema.parse({ allPassed: false, hasNext: false,
      nextParticipants: [], outcomeReferences: [], throughSeq: 3 });
    f.seal(preparation);
    await expect(f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'] }, f.context(round.complete)))
      .resolves.toMatchObject({ ok: true, result: { allPassed: true, hasNext: false, outcomeReferences: [] } });
  });
  it.each(['collection-in-if', 'projector-in-if'] as const)('retains the same lexical scope across a selected conditional (%s)', async conditionalShape => {
    const f = await fixture(conditionalShape, 2);
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], preparationBlockId: 'context' },
      f.context(f.rounds[2]!.complete));
    expect(result, JSON.stringify({ result, cost: f.cost })).toMatchObject({ ok: true,
      result: { throughSeq: 3, nextParticipants: expect.any(Array), outcomeReferences: expect.any(Array) } });
    if (!result.ok) throw new Error('Conditional projection unavailable');
    const projected = WorkflowDiscussionRoundProjectResultV1Schema.parse(result.result);
    expect(projected.outcomeReferences.map(outcome => outcome.participant)).toEqual([
      { kind: 'session', session: { serverId: 'home', sessionId: 'participant-0' } },
      { kind: 'session', session: { serverId: 'home', sessionId: 'participant-1' } },
    ]);
    expect(f.cost.historyPages).toBe(0);
  });

  it('opens only the preceding projection on a scale-shaped three-round Run', async () => {
    const f = await fixture(undefined, participantCount);
    const result = await f.executor.execute('workflow.discussion.round.project', { collections: ['speakers'], phase: 'prepare',
      rosterInput: 'participants', previousProjectionBlockId: 'outcomes' }, f.context(f.rounds[2]!.prepare));
    expect(result, JSON.stringify({ result, cost: f.cost })).toMatchObject({ ok: true, result: { hasNext: true, nextParticipants: expect.any(Array), throughSeq: 2 } });
    expect(f.cost.historyPages).toBe(0);
    expect(f.cost.envelopes).toBeLessThan(12);
  });

  it('reads the current collection without reopening earlier rounds and rejects a misbound selector', async () => {
    const f = await fixture(undefined, participantCount);
    const input = { collections: ['speakers'], preparationBlockId: 'context' };
    const result = await f.executor.execute('workflow.discussion.round.project', input, f.context(f.rounds[2]!.complete));
    expect(result, JSON.stringify({ result, cost: f.cost })).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Projection unavailable');
    const projected = WorkflowDiscussionRoundProjectResultV1Schema.parse(result.result);
    expect(projected.outcomeReferences).toHaveLength(participantCount);
    expect(f.cost.historyPages).toBe(0);
    expect(f.cost.envelopes).toBeLessThan(2 * participantCount + 10);
    expect(f.cost.requests).toBeLessThan(20);
    f.miswire();
    await expect(f.executor.execute('workflow.discussion.round.project', input, f.context(f.rounds[2]!.complete)))
      .resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
});
