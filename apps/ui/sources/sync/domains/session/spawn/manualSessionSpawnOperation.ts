import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export function buildManualSessionCreationKey(userAttemptId: string) {
    const normalized = userAttemptId.trim();
    if (!normalized) throw new Error('Manual Session user-attempt identity is unavailable');
    return SessionCreationKeyV1Schema.parse(`manual:${normalized}`);
}

/** Requester Actions retain the click id; direct spawn RPCs use their creation key. */
export function readManualSessionSpawnOperation(
    scope: ServerAccountScope,
    userAttemptId: string,
): ActionOperationSnapshotV1 | null {
    const state = actionOperationStore.getSnapshot();
    for (const requestId of [userAttemptId, buildManualSessionCreationKey(userAttemptId)]) {
        const operation = actionOperationSelectors.selectSnapshotByRequestId(state, requestId, scope.serverId, scope.accountId);
        if (operation?.actionId === 'session.spawn_new') return operation;
    }
    return null;
}

/** Settled list rows omit result bodies; inspect the same qualified operation before consuming one. */
export async function readManualSessionSpawnOperationDetails(
    scope: ServerAccountScope,
    operation: ActionOperationSnapshotV1,
    shouldContinue: () => boolean = () => true,
): Promise<ActionOperationSnapshotV1 | null> {
    if (!shouldContinue()) return null;
    if (operation.state !== 'succeeded' || operation.result !== undefined) return operation;
    const { getActionOperation } = await import('@/sync/ops/actionOperations');
    if (!shouldContinue()) return null;
    const response = await getActionOperation({
        serverId: scope.serverId, accountId: scope.accountId,
        machineId: operation.scope.machineId, operationId: operation.operationId,
    });
    if (!shouldContinue()) return null;
    if (response.kind !== 'found'
        || response.operation.operationId !== operation.operationId
        || response.operation.actionId !== 'session.spawn_new'
        || response.operation.requestId !== operation.requestId
        || response.operation.scope.accountId !== scope.accountId
        || response.operation.scope.machineId !== operation.scope.machineId
        || response.operation.scope.sessionId !== operation.scope.sessionId
        || response.operation.revision < operation.revision
        || response.operation.state !== 'succeeded'
        || response.operation.result === undefined) {
        throw new Error('action_operation_result_unavailable');
    }
    return response.operation;
}

/** Observe daemon custody until settlement or the originating draft's retirement. */
export async function awaitManualSessionSpawnOperation(
    scope: ServerAccountScope,
    userAttemptId: string,
    signal: AbortSignal,
): Promise<ActionOperationSnapshotV1 | null> {
    const operation = await new Promise<ActionOperationSnapshotV1 | null>(resolve => {
        let unsubscribe = () => {};
        const finish = (operation: ActionOperationSnapshotV1 | null) => {
            unsubscribe();
            signal.removeEventListener('abort', abort);
            resolve(operation);
        };
        const abort = () => finish(null);
        const read = () => {
            const operation = readManualSessionSpawnOperation(scope, userAttemptId);
            if (operation && (operation.state === 'succeeded' || operation.state === 'failed' || operation.state === 'cancelled')) {
                finish(operation);
            }
        };
        unsubscribe = actionOperationStore.subscribe(read);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else read();
    });
    return operation ? await readManualSessionSpawnOperationDetails(scope, operation, () => !signal.aborted) : null;
}
