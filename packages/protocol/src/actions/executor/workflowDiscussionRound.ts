import { readActionWorkflowInvocationContextV1 } from './workflowSessionScope.js';
import { WorkflowDiscussionRoundProjectInputV1Schema, WorkflowDiscussionRoundProjectResultV1Schema } from '../../workflows/workflowDiscussionRoundV1.js';
import { resolveWorkflowInvocationStructureV1 } from '../../workflows/workflowInvocationStructureV1.js';
import { resolveWorkflowAcceptedStepSelectionV1 } from '../../workflows/workflowStepSelectionV1.js';
import { sameStrictJsonValue, StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import type { ActionExecuteResult } from '../actionExecutionResult.js';
import { normalizeExecutableParticipantSelectionV1, type ExecutableParticipantSelectionV1 } from '../../discussions/executableParticipants.js';
import type { DiscussionOpenedMessageV1 } from '../../discussions/actions.js';
import { readWorkflowDiscussionContextV1 } from '../../workflows/workflowDiscussionContextV1.js';

/** No round store: derive only from authorized, committed invocation and reply facts. */
export async function executeWorkflowDiscussionRoundProjectV1(input: unknown, context: ActionExecutorContext,
  deps: ActionExecutorDeps): Promise<ActionExecuteResult> {
  const request = WorkflowDiscussionRoundProjectInputV1Schema.parse(input);
  const binding = await readActionWorkflowInvocationContextV1('workflow.discussion.round.project', context, deps);
  const unavailable = (): ActionExecuteResult => ({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
  if (!binding) return unavailable();
  const { rows, opened, invocation } = binding;
  const origin = 'origin' in opened.acceptedContext ? opened.acceptedContext.origin?.discussion : undefined;
  if (request.phase === 'prepare') {
    const declaration = binding.structure.definition.inputs.find(field => field.name === request.rosterInput);
    const raw = request.rosterInput ? binding.structure.inputs[request.rosterInput] : undefined;
    if (!declaration?.multiple || !declaration.inputType || !('hostType' in declaration.inputType)
      || declaration.inputType.hostType !== 'agentParticipant' || !Array.isArray(raw)) return unavailable();
    const roster: ExecutableParticipantSelectionV1[] = [];
    for (const value of raw) {
      const participant = normalizeExecutableParticipantSelectionV1(value);
      if (!participant) return unavailable();
      roster.push(participant);
    }
    const loop = binding.structure.frame.loop;
    if (!loop) return unavailable();
    let prior: ReturnType<typeof WorkflowDiscussionRoundProjectResultV1Schema.parse> | undefined;
    if (loop.index > 0) {
      const scope = invocation.progress.invocationPath.scope.map(part => part.kind === 'iteration' && part.blockId === loop.blockId
        ? { ...part, index: loop.index - 1 } : part);
      const previous = [...rows.values()].find(row => row.index.lifecycle === 'completed' && row.progress.blockKind === 'action'
        && row.progress.invocationPath.blockId === request.previousProjectionBlockId
        && sameStrictJsonValue(row.progress.invocationPath.scope, scope));
      const parsed = WorkflowDiscussionRoundProjectResultV1Schema.safeParse(previous?.progress.result);
      if (!parsed.success) return unavailable();
      prior = parsed.data;
    }
    const nextParticipants = prior ? [...prior.nextParticipants] : [...roster];
    if (nextParticipants.some(participant => !roster.some(admitted => sameStrictJsonValue(participant, admitted)))) return unavailable();
    let throughSeq = prior?.throughSeq ?? origin?.throughSeq;
    const sinceSeq = throughSeq;
    const messages: DiscussionOpenedMessageV1[] = [];
    if (origin) {
      if (!deps.discussionAction || !context.serverId) return unavailable();
      const read = await readWorkflowDiscussionContextV1({ origin, scope: 'so_far', ...(sinceSeq === undefined ? {} : { afterSeq: sinceSeq }),
        context, discussionAction: deps.discussionAction, resolveServerProfileScopeId: deps.resolveServerProfileScopeId });
      if (!read.ok) return unavailable();
      throughSeq = read.context.throughSeq;
      messages.push(...read.context.messages.filter(message => !message.producerV1));
      const addressed = new Set(messages.flatMap(message => message.addressingV1?.participantSessionIds
        .filter(id => !message.addressingV1?.watcherSessionIds?.includes(id)) ?? []));
      for (const participant of roster) {
        const sessionId = participant.kind === 'session' ? participant.session.sessionId
          : prior?.outcomeReferences.find(outcome => sameStrictJsonValue(outcome.participant, participant))?.executionSessionId;
        if (sessionId && addressed.has(sessionId) && !nextParticipants.some(selected => sameStrictJsonValue(selected, participant))) nextParticipants.push(participant);
      }
    }
    return { ok: true, result: WorkflowDiscussionRoundProjectResultV1Schema.parse({ allPassed: false, hasNext: nextParticipants.length > 0,
      nextParticipants, outcomeReferences: prior?.outcomeReferences ?? [], ...(throughSeq === undefined ? {} : { throughSeq }),
      ...(origin ? { context: StrictJsonValueSchema.parse({ discussion: origin.discussion, throughSeq,
        messages: messages.sort((left, right) => left.seq - right.seq) }) } : {}) }) };
  }
  const collections = [...rows.values()].filter(row => row.progress.blockKind === 'loop' && !row.progress.frame
    && request.collections.includes(row.progress.invocationPath.blockId)
    && sameStrictJsonValue(row.progress.invocationPath.scope, invocation.progress.invocationPath.scope)
    && row.index.lifecycle === 'completed');
  if (collections.length !== 1) return unavailable();
  const collection = collections[0]!;
  const descendants = [...rows.values()].filter(row => {
    if (row.progress.blockKind !== 'step' || row.index.lifecycle === 'superseded' || row.index.lifecycle === 'skipped') return false;
    const seen = new Set<string>();
    for (let parent = row.index.parentRecordId; parent && !seen.has(parent); parent = rows.get(parent)?.index.parentRecordId ?? null) {
      if (parent === collection.index.id) return true;
      seen.add(parent);
    }
    return false;
  });
  const outcomeReferences: ReturnType<typeof WorkflowDiscussionRoundProjectResultV1Schema.parse>['outcomeReferences'] = [];
  for (const row of descendants) {
    const structure = await resolveWorkflowInvocationStructureV1({ definition: opened.definition,
      inputs: opened.acceptedContext.inputs, frozenChildren: opened.acceptedContext.frozenChildren, invocation: row,
      readInvocation: async id => rows.get(id), keyOfInvocation: row => row.index.id });
    if (!structure || structure.leaf.kind !== 'step') return unavailable();
    const leaf = opened.acceptedContext.materializedLeaves.find(leaf => leaf.sourceKey === structure.sourceKey && leaf.blockId === structure.leaf.id);
    if (!leaf?.participantBindings) return unavailable();
    const selected = resolveWorkflowAcceptedStepSelectionV1(leaf, structure.frame.item?.value, structure.inputs);
    const participant = leaf.participantBindings.selections.find(choice => sameStrictJsonValue(choice.participant, selected.participant))?.value;
    if (!participant) return unavailable();
    const reply = row.progress.replyOutcome;
    const kind = row.index.lifecycle === 'failed' ? 'failed' : row.index.lifecycle === 'cancelled' ? 'cancelled'
      : row.index.lifecycle !== 'completed' ? null : reply?.kind ?? null;
    // Missing reply custody is not an answer or pass, even when prose exists.
    if (!kind) return unavailable();
    outcomeReferences.push({ runId: opened.run.id, invocationRecordId: row.index.id, participant, kind,
      ...(row.progress.execution?.kind === 'session' ? { executionSessionId: row.progress.execution.sessionId } : {}),
      ...(row.progress.result === undefined ? {} : { result: row.progress.result }),
      ...(reply ? { reply: StrictJsonValueSchema.parse(reply) } : {}) });
  }
  const prepared = [...rows.values()].find(row => row.progress.blockKind === 'action' && row.index.lifecycle === 'completed'
    && row.progress.invocationPath.blockId === request.preparationBlockId
    && sameStrictJsonValue(row.progress.invocationPath.scope, invocation.progress.invocationPath.scope));
  const preparation = WorkflowDiscussionRoundProjectResultV1Schema.safeParse(prepared?.progress.result);
  const nextParticipants = outcomeReferences.filter(outcome => outcome.kind === 'answer').map(outcome => outcome.participant);
  return { ok: true, result: WorkflowDiscussionRoundProjectResultV1Schema.parse({
    allPassed: outcomeReferences.length === 0 || outcomeReferences.every(outcome => outcome.kind === 'pass'),
    hasNext: nextParticipants.length > 0,
    ...(preparation.success && preparation.data.throughSeq !== undefined ? { throughSeq: preparation.data.throughSeq } : {}),
    nextParticipants,
    outcomeReferences,
  }) };
}
