import type {
    BeginScmProjectOperationResult,
    ScmProjectOperationKind,
} from '@/sync/runtime/orchestration/projectManager';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

type ScmOperationLockState = {
    beginSessionProjectScmOperation: (
        sessionId: string,
        operation: ScmProjectOperationKind,
        serverId?: string,
    ) => BeginScmProjectOperationResult;
    finishSessionProjectScmOperation: (sessionId: string, operationId: string, serverId?: string) => boolean;
    updateSessionProjectScmOperationProgress: (sessionId: string, operationId: string, progressText?: string, serverId?: string) => boolean;
};

type ScmWorkspaceOperationLockState = {
    beginWorkspaceScmOperation: (
        scope: WorkspaceScopeBase,
        operation: ScmProjectOperationKind,
        serverId?: string,
    ) => BeginScmProjectOperationResult;
    finishWorkspaceScmOperation: (scope: WorkspaceScopeBase, operationId: string, serverId?: string) => boolean;
    updateWorkspaceScmOperationProgress: (scope: WorkspaceScopeBase, operationId: string, progressText?: string) => boolean;
};

export type WithSessionProjectScmOperationResult<T> =
    | { started: false; message: string }
    | { started: true; value: T };

export type WithWorkspaceScmOperationResult<T> = WithSessionProjectScmOperationResult<T>;

/**
 * An operation holds the lock `queued` until it runs. The lock starts `running` at once unless the caller sets
 * `deferRunning` and calls the `markRunning` it is handed: a write that is first confirmed by the person (the
 * Action's in-place dialog) waits `queued`, which the pane does not show as work in progress, and runs from
 * the moment its Action is dispatched.
 */
type ScmOperationLockRun<T> = (markRunning: () => void) => Promise<T>;

export async function withSessionProjectScmOperationLock<T>(input: {
    state: ScmOperationLockState;
    sessionId: string;
    serverId?: string;
    operation: ScmProjectOperationKind;
    deferRunning?: boolean;
    run: ScmOperationLockRun<T>;
}): Promise<WithSessionProjectScmOperationResult<T>> {
    const start = input.state.beginSessionProjectScmOperation(input.sessionId, input.operation, ...(input.serverId === undefined ? [] : [input.serverId]));
    if (!start.started) {
        return {
            started: false,
            message: toBlockedMessage(start),
        };
    }

    const operationId = start.operation.id;
    try {
        const markRunning = () => { input.state.updateSessionProjectScmOperationProgress(input.sessionId, operationId, undefined, ...(input.serverId === undefined ? [] : [input.serverId])); };
        if (!input.deferRunning) markRunning();
        const value = await input.run(markRunning);
        return { started: true, value };
    } finally {
        input.state.finishSessionProjectScmOperation(input.sessionId, operationId, ...(input.serverId === undefined ? [] : [input.serverId]));
    }
}

export async function withWorkspaceScmOperationLock<T>(input: {
    state: ScmWorkspaceOperationLockState;
    scope: WorkspaceScopeBase;
    operation: ScmProjectOperationKind;
    deferRunning?: boolean;
    run: ScmOperationLockRun<T>;
}): Promise<WithWorkspaceScmOperationResult<T>> {
    const start = input.state.beginWorkspaceScmOperation(input.scope, input.operation);
    if (!start.started) {
        return {
            started: false,
            message: toBlockedMessage(start),
        };
    }

    const operationId = start.operation.id;
    try {
        const markRunning = () => { input.state.updateWorkspaceScmOperationProgress(input.scope, operationId); };
        if (!input.deferRunning) markRunning();
        const value = await input.run(markRunning);
        return { started: true, value };
    } finally {
        input.state.finishWorkspaceScmOperation(input.scope, operationId);
    }
}

function toBlockedMessage(start: Extract<BeginScmProjectOperationResult, { started: false }>): string {
    if (start.reason === 'missing_project') {
        return 'Session project context is unavailable.';
    }
    if (start.inFlight) {
        return `Another source-control operation is already running (${start.inFlight.operation}).`;
    }
    return 'Another source-control operation is already running.';
}
