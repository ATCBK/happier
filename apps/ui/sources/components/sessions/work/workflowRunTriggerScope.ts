import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

const EMPTY_TRIGGER_RUN_IDS: ReadonlySet<string> = new Set();

/** Only immutable trigger causes need scope to establish Work membership. */
export function isTriggeredWorkflowRun(run: WorkflowRunSummaryV1): boolean {
    if (run.origin.kind !== 'automation') return false;
    const cause = run.origin.cause;
    return cause?.kind === 'trigger' || (cause?.kind === 'conversation' && cause.triggerId !== undefined);
}

/** Own-trigger Runs belong to Triggers; manual and unknown causes stay in Work. */
export function readOwnTriggerRunIds(params: Readonly<{
    sessionId: string;
    runs: readonly WorkflowRunSummaryV1[];
}>): ReadonlySet<string> {
    let ids: Set<string> | null = null;
    for (const run of params.runs) {
        if (!isTriggeredWorkflowRun(run) || run.automationScopeSessionId !== params.sessionId) continue;
        (ids ??= new Set()).add(run.id);
    }
    return ids ?? EMPTY_TRIGGER_RUN_IDS;
}
