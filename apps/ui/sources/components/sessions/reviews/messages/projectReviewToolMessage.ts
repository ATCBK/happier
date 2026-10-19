import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ScmDiffSummaryGenerateSuccessSchema } from '@happier-dev/protocol/scm/diffSummary';

import { readReviewPayload } from '../findings/readReviewPayload';
import { resolveReviewRunStatus } from '../findings/resolveReviewRunStatus';

export function readReviewToolRunId(message: ToolCallMessage): string | null {
    if (message.tool.name !== 'SubAgentRun') return null;
    const input: unknown = message.tool.input;
    return input && typeof input === 'object' && 'intent' in input && input.intent === 'review'
        && 'runId' in input && typeof input.runId === 'string' && input.runId.length > 0 ? input.runId : null;
}

/** Present the published review phase without changing its retained Run or transcript lifecycle. */
export function projectReviewToolMessage(message: ToolCallMessage): ToolCallMessage {
    const runId = readReviewToolRunId(message);
    if (!runId || message.tool.state !== 'running' || message.meta?.happier !== undefined) return message;
    for (let index = message.children.length - 1; index >= 0; index -= 1) {
        const child = message.children[index];
        if (child.kind !== 'agent-text') continue;
        const payload = readReviewPayload(child.meta?.happier);
        if (!payload || payload.runRef.runId !== runId || payload.runRef.callId !== message.tool.id) continue;
        const status = resolveReviewRunStatus({ payload });
        if (status !== 'succeeded' && status !== 'failed') continue;
        return {
            ...message,
            meta: { ...message.meta, happier: child.meta?.happier },
            tool: { ...message.tool, state: status === 'failed' ? 'error' : 'completed', completedAt: payload.generatedAtMs },
        };
    }
    for (let index = message.children.length - 1; index >= 0; index -= 1) {
        const child = message.children[index];
        const meta: unknown = child.meta?.happier;
        if (child.kind !== 'agent-text' || !meta || typeof meta !== 'object' || !('kind' in meta)
            || meta.kind !== 'scm_diff_summary.v1' || !('payload' in meta)) continue;
        const output = meta.payload;
        if (!output || typeof output !== 'object' || !('producer' in output)) continue;
        const producer = createStoredReadSchema(ScmDiffSummaryGenerateSuccessSchema.shape.producer).safeParse(output.producer);
        if (!producer.success || producer.data?.kind !== 'review') continue;
        const recorded = producer.data.reviewedRuns?.find((review) => review.runId === runId && review.callId === message.tool.id);
        if (!recorded || recorded.hasOutput) continue;
        const status = resolveReviewRunStatus({ recorded });
        if (status !== 'succeeded' && status !== 'failed') continue;
        return { ...message, tool: { ...message.tool, state: status === 'failed' ? 'error' : 'completed',
            completedAt: producer.data.narratedAtMs ?? child.createdAt } };
    }
    return message;
}
