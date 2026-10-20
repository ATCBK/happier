import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';

import type { SessionLifecycleActionHandler, SessionLifecycleMachineDeps, SessionLifecycleMachineHandlers } from './sessionLifecycleTypes';

/** Keep the original operation live until the existing tracked-runner owner observes native open. */
export function createSessionStartupProjectSpawn(input: Readonly<{
    context: Parameters<SessionLifecycleActionHandler>[1];
    spawnSession: SessionLifecycleMachineHandlers['spawnSession'];
    awaitAgentSessionOpen?: SessionLifecycleMachineDeps['awaitAgentSessionOpen'];
}>): SessionLifecycleMachineHandlers['spawnSession'] {
    const context = input.context;
    const local = context?.localActionContext;
    const operation: ProjectSetupOperationContext | undefined = context?.signal && local?.operationAcceptance
        && local.operationProgress && local.operationOwnerUpdate && local.operationReview
        ? { signal: context.signal, actionRequestId: local.actionRequestId ?? undefined,
            operationProgress: local.operationProgress, operationOwnerUpdate: local.operationOwnerUpdate,
            operationAcceptance: local.operationAcceptance, operationReview: local.operationReview,
            ...(local.operationCancellation ? { operationCancellation: local.operationCancellation } : {}),
            ...(local.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: local.requesterWorkAttributionV1 } : {}) }
        : undefined;
    return async options => {
        if (operation && !input.awaitAgentSessionOpen) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Session native startup observation unavailable' };
        }
        const result = await input.spawnSession({ ...options, ...(operation ? { projectSetupOperation: operation } : {}) });
        if (result.type !== 'success' || !result.sessionId || !operation) return result;
        // The webhook acknowledges physical launch. The original execution
        // remains active, retaining its setup review and cancellation custody.
        if (operation.operationAcceptance?.actionId === 'session.spawn_new') {
            operation.operationAcceptance.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });
        }
        const opened = await input.awaitAgentSessionOpen!({ sessionId: result.sessionId,
            timeoutMs: null, signal: operation.signal });
        operation.signal.throwIfAborted();
        return opened.status === 'opened' ? result
            : { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                errorMessage: 'Agent runner exited before native Session startup completed' };
    };
}
