import type { WorkflowInvocationBindingRowV1 } from './workflowInvocationStructureV1.js';
import type { WorkflowRunInvocationIndexV1 } from './workflowProgressV1.js';

/**
 * A recovered structural parent inherits its nearest unreplaced member slots.
 * Select the newest physical attempt before inheriting; skipped/superseded slots
 * still mask older slots. Consumers retain tombstones for scheduling or exclude
 * them from results. Read all requested parents together at each recovery depth.
 */
export async function readWorkflowInvocationMembersV1<T>(params: Readonly<{
  parentRecordIds: readonly string[];
  memberOrdinal?: string;
  readParent: (id: string) => Promise<WorkflowInvocationBindingRowV1 | undefined>;
  readChildren: (parentRecordIds: string[]) => Promise<readonly T[]>;
  indexOf: (row: T) => WorkflowRunInvocationIndexV1;
}>): Promise<ReadonlyMap<string, readonly T[]>> {
  const selections = new Map([...new Set(params.parentRecordIds)].map(id => [id, new Map<string, T>()]));
  let pending = [...selections].map(([id, members]) => ({ id, members, seen: new Set<string>() }));
  while (pending.length) {
    const parentIds = [...new Set(pending.map(parent => parent.id))];
    const slots = new Map(parentIds.map(id => [id, new Map<string, T>()]));
    for (const row of await params.readChildren(parentIds)) {
      const index = params.indexOf(row);
      const members = index.parentRecordId === null ? undefined : slots.get(index.parentRecordId);
      if (!members || (params.memberOrdinal !== undefined && index.memberOrdinal !== params.memberOrdinal)) {
        throw new Error('workflow_member_selection_invalid');
      }
      const previous = members.get(index.memberOrdinal);
      if (!previous || BigInt(index.attempt) > BigInt(params.indexOf(previous).attempt)) members.set(index.memberOrdinal, row);
    }
    const next = await Promise.all(pending.map(async state => {
      if (state.seen.has(state.id)) throw new Error('workflow_member_ancestry_invalid');
      state.seen.add(state.id);
      for (const [ordinal, row] of slots.get(state.id)!) if (!state.members.has(ordinal)) state.members.set(ordinal, row);
      // An exact selected slot needs no older history or parent content.
      if (params.memberOrdinal !== undefined && state.members.has(params.memberOrdinal)) return undefined;
      const parent = await params.readParent(state.id);
      if (!parent || parent.index.id !== state.id) throw new Error('workflow_parent_invocation_missing');
      return parent.progress.previousAttemptRecordId ? { ...state, id: parent.progress.previousAttemptRecordId } : undefined;
    }));
    pending = next.filter(state => state !== undefined);
  }
  return new Map([...selections].map(([id, members]) => [id, [...members.values()].sort((left, right) => {
    const a = BigInt(params.indexOf(left).memberOrdinal);
    const b = BigInt(params.indexOf(right).memberOrdinal);
    return a < b ? -1 : a > b ? 1 : 0;
  })]));
}
