import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';

/** Inbox placement and tone share one mapping; other Work surfaces keep their own presentation. */
export function presentInboxWorkflowRun(summary: WorkflowRunSummaryV1 | null | undefined): Readonly<{
    type: 'decision' | 'update';
    view: 'needs_you' | 'updates';
    status: WorkStatusPresentation | null;
}> {
    const needsYou = summary?.state === 'waiting_for_review' || Boolean(summary?.heldStep) || (summary?.heldCount ?? 0) > 0;
    const status = summary ? resolveWorkStatusTone({ kind: 'workflow_run', facts: {
        state: summary.state, word: describeWorkflowRunState(summary.state, {
            inAttentionWindow: needsYou, workflowCustodyState: summary.workflowCustodyState,
        }).label, inAttentionWindow: needsYou, workflowCustodyState: summary.workflowCustodyState,
    } }) : null;
    return {
        type: needsYou ? 'decision' : 'update',
        view: needsYou ? 'needs_you' : 'updates',
        status: status && summary?.state === 'interrupted' && !needsYou ? { ...status, tone: 'neutral' } : status,
    };
}
