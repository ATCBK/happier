import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

/** A Habit belongs here when it starts here or its accepted graph writes here. */
export function isWorkflowTriggerSetAttachedToSession(set: WorkflowTriggerSetV1, sessionId: string): boolean {
    return set.scopeSessionId === sessionId || workflowTriggerSetWritesToSession(set, sessionId);
}

export function workflowTriggerSetWritesToSession(set: WorkflowTriggerSetV1, sessionId: string): boolean {
    return set.destinations?.targetSessionIds.includes(sessionId) === true;
}
