import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol';
import { t } from '@/text';
import { describeWorkflowInvocationLifecycle } from './workflowLifecyclePresentation';

/** FIN's authored-step summary is distinct from public invocation counts. */
export function describeWorkflowRunProgress(progress: WorkflowRunSummaryV1['stepProgress']): string | null {
    return progress ? [
        t('workflows.list.stepsProgress', progress),
        progress.currentLoop ? t('workflows.list.loopProgress', progress.currentLoop) : null,
    ].filter(Boolean).join(' · ') : null;
}

/**
 * Accepted destination identity with an exact observed state, never a guessed loop total.
 *
 * `saidStatus` is a status word the row already shows (the Run's own trailing word): a step whose
 * observed state is that same word adds nothing, so only a differing observation is stated.
 */
export function describeWorkflowRunDestinationProgress(progress: WorkflowRunSummaryV1['stepProgress'], sessionId: string,
    options?: Readonly<{ saidStatus?: string }>): string[] {
    return progress?.destinations?.flatMap(leaf => {
        if (!leaf.sessionIds.includes(sessionId) || leaf.ordinal === undefined) return [];
        const label = t('sessionWork.scheduled.step', { ordinal: leaf.ordinal,
            title: leaf.name?.trim() || t('message.provenanceWorkflow') });
        const observed = leaf.observation
            ? describeWorkflowInvocationLifecycle(leaf.observation.lifecycle, { blockKind: leaf.observation.blockKind }).label : null;
        return [[label, observed !== null && observed !== options?.saidStatus ? observed : null].filter(Boolean).join(' · ')];
    }) ?? [];
}
