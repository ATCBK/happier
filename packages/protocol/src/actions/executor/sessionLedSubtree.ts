import { parseSessionListQueryActionResultV1 } from '../../sessions/awareness/action.js';
import { SESSION_LIST_PAGE_MAX_LIMIT, type SessionListQueryV1 } from '../../sessions/listing/query.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';

/** Reads server-proved membership; relation structure and ordinary access stay server-owned. */
export async function readActionCallerLedSubtreeSessionIds(
  deps: Pick<ActionExecutorDeps, 'sessionList'>,
  context: ActionExecutorContext,
  requestedRootSessionId?: string,
): Promise<ReadonlySet<string> | null> {
  const root = (requestedRootSessionId ?? context.defaultSessionId)?.trim();
  if (!root || context.sessionListAccess === 'unavailable') return null;
  if (context.sessionListAccess === 'current_session') {
    return root === context.defaultSessionId?.trim() ? new Set([root]) : null;
  }
  // This is the receiving Session owner's policy observation, not a delegated
  // HTTP effect of the Run. Its Account reader proves current relations; it
  // cannot sign as the original Run executor. Keep the signed caller proof on
  // the mutation context, but do not borrow its signer for this private read.
  const readContext = context.actionCaller?.kind === 'workflowRun'
    && context.externalActionExecutionAuthorization?.binding.workflowActionOrigin?.sessionAuthority
    ? { ...context, externalActionExecutionAuthorization: undefined }
    : context;
  // Storage partitions are independent Home reads. Preserve pagination within
  // each partition and require both to complete before admitting membership.
  const partitions = await Promise.all((['active', 'archived'] as const).map(async storage => {
    const ids = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const query: SessionListQueryV1 = {
        v: 1, storage, includeInactive: true, scope: 'all_accessible', attention: 'any',
        audiences: [], tagIds: [], underSessionId: root, limit: SESSION_LIST_PAGE_MAX_LIMIT,
        ...(cursor ? { cursor } : {}),
      };
      let result: ReturnType<typeof parseSessionListQueryActionResultV1>;
      try {
        result = parseSessionListQueryActionResultV1(await deps.sessionList({
          context: readContext, query,
          ...(context.serverId !== undefined ? { serverId: context.serverId } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        }));
      } catch {
        return null;
      }
      if (!result || result.hasNext === undefined) return null;
      for (const session of result.sessions) {
        const id: unknown = 'id' in session ? session.id : 'sessionId' in session ? session.sessionId : undefined;
        if (typeof id === 'string') ids.add(id);
      }
      if (!result.hasNext) break;
      if (!result.nextCursor || seenCursors.has(result.nextCursor)) return null;
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    } while (true);
    return ids;
  }));
  if (partitions.some(ids => ids === null) || context.signal?.aborted) return null;
  return new Set(partitions.flatMap(ids => ids ? [...ids] : []));
}
