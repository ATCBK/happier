import { WorkflowRunGetResultV1Schema, WorkflowInvocationListResultV1Schema } from '../../workflows/actionsV1.js';
import { resolveWorkflowInvocationStructureV1, type WorkflowInvocationBindingRowV1 } from '../../workflows/workflowInvocationStructureV1.js';
import { readWorkflowActionInvocationV1, type WorkflowSessionScopeV1 } from '../../workflows/workflowSessionScopeV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { areServerProfileIdentifiersEquivalent } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import type { ActionId } from '../actionIds.js';

/** Opens the exact accepted frame; neither Action operands nor sibling targets supply authority. */
export async function resolveActionWorkflowSessionScopeV1(
  actionId: ActionId, context: ActionExecutorContext,
  deps: Pick<ActionExecutorDeps, 'workflowAction' | 'resolveSessionReference' | 'resolveServerProfileScopeId'>,
): Promise<WorkflowSessionScopeV1 | null> {
  if (actionId !== 'review.start' && !actionId.startsWith('reviews.comments.')) return null;
  const caller = context.actionCaller;
  if (caller?.kind !== 'workflowRun' || !deps.workflowAction) return null;
  const identity = readWorkflowActionInvocationV1(caller.runId, context.actionRequestId ?? undefined);
  if (!identity) return null;
  const workflowAction = deps.workflowAction;
  const invoke = async (request: Parameters<NonNullable<ActionExecutorDeps['workflowAction']>>[0]) => workflowAction(request);
  const common = { context, ...(context.signal ? { signal: context.signal } : {}) };
  try {
    const opened = WorkflowRunGetResultV1Schema.parse(await invoke({ ...common,
      actionId: 'workflow.run.get', input: { runId: caller.runId } }));
    if (opened.run.id !== caller.runId) return null;
    // This history view lives only for this scope resolution. It neither retains
    // authority across Actions nor replaces each effect's current Session check.
    const rows = new Map<string, WorkflowInvocationBindingRowV1>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      context.signal?.throwIfAborted();
      const page = WorkflowInvocationListResultV1Schema.parse(await invoke({ ...common,
        actionId: 'workflow.run.invocations.list', input: { runId: caller.runId, includeContent: true,
          ...(cursor ? { cursor } : {}) } }));
      const details = page.invocationDetails;
      if (!details || details.length !== page.invocations.length) return null;
      const indices = new Map(page.invocations.map(index => [index.id, index]));
      if (indices.size !== page.invocations.length) return null;
      for (const detail of details) {
        const index = indices.get(detail.index.id);
        if (!index || index.runId !== caller.runId || !sameStrictJsonValue(index, detail.index)
          || detail.parentRevision !== page.parentRevision || detail.progress.attempt !== index.attempt
          || rows.has(index.id)) return null;
        rows.set(index.id, detail);
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) return null;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const read = async (invocationId: string) => rows.get(invocationId);
    const logical = await read(identity.logicalInvocationId);
    if (!logical) return null;
    let invocation = logical.index.attempt === identity.attempt ? logical : undefined;
    if (!invocation && logical.index.parentRecordId !== null) {
      const selected = [...rows.values()].filter(row => row.index.parentRecordId === logical.index.parentRecordId
        && row.index.memberOrdinal === logical.index.memberOrdinal && row.index.attempt === identity.attempt
        && row.index.lifecycle !== 'superseded');
      if (selected.length !== 1) return null;
      invocation = selected[0];
    }
    if (!invocation || invocation.index.lifecycle === 'superseded' || invocation.progress.blockKind !== 'action'
      || invocation.progress.attempt !== identity.attempt || invocation.progress.logicalInvocationRecordId !== identity.logicalInvocationId
      || (invocation.progress.execution && (invocation.progress.execution.kind !== 'action'
        || invocation.progress.execution.actionId !== actionId || invocation.progress.execution.actionRequestId !== context.actionRequestId))) return null;
    const structure = await resolveWorkflowInvocationStructureV1({ definition: opened.definition,
      frozenChildren: opened.acceptedContext.frozenChildren, inputs: opened.acceptedContext.inputs,
      invocation, readInvocation: read, keyOfInvocation: row => row.index.id });
    if (structure?.leaf.kind !== 'action' || structure.leaf.actionId !== actionId) return null;
    const leaf = opened.acceptedContext.materializedLeaves.find(leaf => leaf.sourceKey === structure.sourceKey
      && leaf.blockId === structure.leaf.id && leaf.kind === 'action' && leaf.actionId === actionId);
    if (!leaf) return null;
    const sessions: WorkflowSessionScopeV1['sessions'] = [];
    const sameHome = (left: string, right: string | null | undefined) => areServerProfileIdentifiersEquivalent(left, right,
      identifier => identifier === context.serverId && context.serverIdentityId ? context.serverIdentityId
        : identifier === context.serverIdentityId ? context.serverIdentityId : deps.resolveServerProfileScopeId?.(identifier));
    for (const binding of leaf.sessionAuthorityBindings ?? []) {
      const value = structure.inputs[binding.inputName];
      if (value === undefined && structure.definition.inputs.some(field => field.name === binding.inputName && !field.required)) continue;
      const admitted = binding.targets.find(target => sameStrictJsonValue(target.address, value));
      if (!admitted || !sameHome(admitted.address.serverId, context.serverId) || !deps.resolveSessionReference) return null;
      const current = await deps.resolveSessionReference({ context, actionId, sessionId: admitted.address.sessionId,
        ...(context.signal ? { signal: context.signal } : {}) });
      context.signal?.throwIfAborted();
      if (current.kind !== 'unique' || current.address.sessionId !== admitted.address.sessionId
        || !sameHome(current.address.serverId, admitted.address.serverId)) return null;
      if (!sessions.some(address => sameStrictJsonValue(address, admitted.address))) sessions.push(admitted.address);
    }
    return { actionRequestId: context.actionRequestId!, invocationId: invocation.index.id, sessions };
  } catch {
    return null;
  }
}
