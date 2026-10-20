import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionCompletionOperation } from '@happier-dev/protocol/actions/actionCompletion';

/** Terminal startup failure remains a fact after its process-local owner retires. */
export function readRetainedWorkflowSessionStartupFailure(
  snapshot: unknown, address: ActionCompletionOperation, creationKey: string,
): ActionOperationSnapshotV1 | undefined {
  const parsed = ActionOperationSnapshotV1Schema.safeParse(snapshot);
  return parsed.success && parsed.data.state === 'failed' && parsed.data.operationId === address.operationId
    && parsed.data.actionId === 'session.spawn_new' && parsed.data.scope.machineId === address.machineId
    && parsed.data.requestId === creationKey ? parsed.data : undefined;
}
