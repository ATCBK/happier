import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

/** A source Session is admitted by caller custody, never by Artifact header metadata. */
export function readArtifactWorkspaceSourceSessionId(context: ActionExecutorContext): string | null {
    if (context.actionCaller?.kind === 'session') return context.actionCaller.sessionId;
    if (context.surface !== 'ui' || context.authority !== 'present_user' || context.actionCaller?.kind !== 'host'
        || context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization) return null;
    return context.defaultSessionId?.trim() ? context.defaultSessionId : null;
}
