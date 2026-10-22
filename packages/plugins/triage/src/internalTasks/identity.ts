import type { TriageEntryRefV1, TriageSourceEntryLocalRefV1 } from '@happier-dev/triage-protocol/v1';

export const INTERNAL_TASK_SOURCE_V1 = Object.freeze({ pluginId: 'happier.triage', localId: 'internal' });

export function internalTaskLocalRefV1(taskId: string): TriageSourceEntryLocalRefV1 {
  return { kindId: 'task', collisionScope: 'personal', entryId: taskId };
}

export function isInternalTaskReferenceV1(ref: TriageEntryRefV1): boolean {
  return ref.source.pluginId === INTERNAL_TASK_SOURCE_V1.pluginId && ref.source.localId === INTERNAL_TASK_SOURCE_V1.localId
    && ref.kindId === 'task' && ref.collisionScope === 'personal';
}
