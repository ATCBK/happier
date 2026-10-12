import { SessionAuthoringOpenResultV1Schema, type SessionAuthoringOpenResultV1, type SessionAuthoringOpenV1 } from '@happier-dev/protocol/plugins/ui';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

/** A mounted caller supplies the existing approval/result-custody owner. */
export type MountedAuthoringActionExecute = (actionId: ActionId, input: unknown,
    options?: Readonly<{ signal?: AbortSignal }>) => Promise<ActionExecuteResult>;

/** First-party entry points use the same admission as public authoring callers. */
export async function openSessionAuthoringAction(input: SessionAuthoringOpenV1,
    lifetime: ServerAccountScopeLifetime, signal?: AbortSignal,
    executeAction?: MountedAuthoringActionExecute): Promise<SessionAuthoringOpenResultV1> {
    if (!lifetime.isCurrent()) return { kind: 'stale', reason: 'host_retired' };
    if (!executeAction) return { kind: 'unavailable', reason: 'client_unavailable' };
    const result = await executeAction('session.authoring.open', input, { signal });
    if (!lifetime.isCurrent()) return { kind: 'stale', reason: 'host_retired' };
    if (!result.ok) return { kind: 'unavailable', reason: 'client_unavailable' };
    const parsed = SessionAuthoringOpenResultV1Schema.safeParse(result.result);
    return parsed.success ? parsed.data : { kind: 'unavailable', reason: 'client_unavailable' };
}
