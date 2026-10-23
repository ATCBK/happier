import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';
import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from './workflowRunActions.js';
import { WorkflowInvocationListRequestV1Schema } from '../../workflows/actionsV1.js';
import { DEBATE_WORKFLOW_V1 } from '../../workflows/builtins/debate.js';
import { materializeWorkflowAcceptedSnapshotV1 } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { WorkflowProgressEnvelopeV1Schema, WorkflowRunInvocationIndexV1Schema, WorkflowRunSummaryV1Schema } from '../../workflows/workflowProgressV1.js';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '../../workflows/workflowStoredContentV1.js';
import { WorkflowRunRecipientCensusResponseV1Schema } from '../../workflows/workflowRunKeyV1.js';
import { WorkflowDiscussionRoundProjectResultV1Schema } from '../../workflows/workflowDiscussionRoundV1.js';
import type { ActionExecutorContext } from './types.js';
import type { WorkflowBlock, WorkflowDefinitionV1 } from '../../workflows/workflowV1.js';

const runId = '11111111-1111-4111-8111-111111111111';

type ConditionalShape = 'collection-in-if' | 'projector-in-if';

const participantCount = process.env.HAPPIER_WORKFLOW_SCALE_MEASUREMENT === '1' ? 500 : 24;

async function fixture(conditionalShape?: ConditionalShape, participantCount = 2) {
  const conditional = (id: string, blocks: WorkflowBlock[]): WorkflowBlock => ({ kind: 'if', id,
    when: { kind: 'compare', operator: 'eq', left: { kind: 'literal', value: true }, right: { kind: 'literal', value: true } },
    then: blocks, otherwise: [] });
  const definition: WorkflowDefinitionV1 = conditionalShape ? { ...DEBATE_WORKFLOW_V1,
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
  const participants = Array.from({ length: participantCount }, (_, index) => ({ kind: 'session' as const,
    session: { serverId: 'home', sessionId: `participant-${index}` } }));
  const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
    context: { source: { kind: 'inline' }, inputs: { question: 'Review this change', participants, rounds: 3 }, machineId: 'machine-a',
      executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true,
      resolveSessionTarget: async value => {
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
  const loop = add(root, 0, { blockKind: 'loop', invocationPath: { blockId: 'rounds', scope: [] },
    container: { kind: 'loop', mode: 'until', nextMemberIndex: '3', nextBodyBlockOrdinal: '0' } });
  const rounds = [];
  for (let round = 0; round < 3; round += 1) {
    const scope = [{ kind: 'iteration' as const, blockId: 'rounds', index: round }];
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
    binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId }, acceptedSnapshot: accepted.snapshot })), checkpointEnvelope: null, resultEnvelope: null,
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
      if (operation.operation !== 'invocations.list') throw new Error('Unexpected detail/recovery read');
      cost.pages += 1;
      const input = WorkflowInvocationListRequestV1Schema.parse({ runId, ...(operation.invocationId === undefined ? {} : { invocationId: operation.invocationId }),
        ...(operation.parentRecordIds === undefined ? {} : { parentRecordIds: operation.parentRecordIds }),
        ...(operation.parentRecordId === undefined ? {} : { parentRecordId: operation.parentRecordId }),
        ...(operation.memberOrdinal === undefined ? {} : { memberOrdinal: operation.memberOrdinal }) });
      if (!input.invocationId && !input.parentRecordId && !input.parentRecordIds) cost.historyPages += 1;
      let selected = miswire || (miswireChildren && input.parentRecordIds) ? rows.slice(0, 1) : rows.filter(row => (!input.invocationId || row.index.id === input.invocationId)
        && (!input.parentRecordId || row.index.parentRecordId === input.parentRecordId)
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
      return { invocations: page.map(row => row.index), parentRevision: 0, keyCensus: snapshot.keyCensus,
        ...(start + page.length < selected.length ? { nextCursor: String(start + page.length) } : {}),
        ...(operation.progressEnvelopes === true ? { progressEnvelopesByInvocationId: Object.fromEntries(page.map(row => [row.index.id, row.contentEnvelope])) } : {}) };
    } },
  } satisfies WorkflowAccountRunActionDeps);
  const executor = createActionExecutor({ workflowAction: args => owner.execute(args) });
  const context = (id: string): ActionExecutorContext => ({ surface: 'agent', serverId: 'home',
    actionRequestId: `${runId}/${row(id).progress.logicalInvocationRecordId}/${row(id).index.attempt}`,
    actionCaller: { kind: 'workflowRun', runId, authorization: accepted.snapshot.authorization } });
  return { cost, executor, context, rounds, recover, move, row, seal,
    omit: (id: string) => { rows.splice(rows.indexOf(row(id)), 1); }, miswire: () => { miswire = true; },
    miswireChildren: () => { miswireChildren = true; } };
}

describe('Discussion round projection demand', () => {
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
