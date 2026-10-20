import { describe, expect, it } from 'vitest';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import { ScmDiffSummaryGenerateSuccessSchema } from '@happier-dev/protocol/scm/diffSummary';

import { projectReviewToolMessage } from './projectReviewToolMessage';

const findings = ReviewFindingsV2Schema.parse({
    runRef: { runId: 'review', callId: 'review-call', backendId: 'claude' }, reviewOutcome: 'complete',
    summary: 'Reviewed.', overviewMarkdown: 'Overview.', findings: [], generatedAtMs: 2,
});

function parent(payload?: unknown): ToolCallMessage {
    return {
        kind: 'tool-call', id: 'parent', localId: null, createdAt: 1,
        tool: { id: 'review-call', name: 'SubAgentRun', state: 'running',
            input: { runId: 'review', intent: 'review', runClass: 'long_lived', retentionPolicy: 'resumable' },
            createdAt: 1, startedAt: 1, completedAt: null, description: null },
        children: payload === undefined ? [] : [{
            kind: 'agent-text', id: 'findings', localId: null, createdAt: 2, text: 'Reviewed.',
            meta: { happier: { kind: 'review_findings.v2', payload } },
        }],
    };
}

describe('projectReviewToolMessage', () => {
    it('settles no-output review failure only from matching narration producer evidence', () => {
        for (const [runId, callId] of [['review', 'review-call'], ['foreign', 'review-call'], ['review', 'foreign']]) {
            const message = parent();
            const narration = ScmDiffSummaryGenerateSuccessSchema.parse({
                success: true, summaryMarkdown: 'Walkthrough ready.', sourceKey: 'comparison',
                metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
                producer: { kind: 'review', narrationMode: 'continued_review', reviewedRuns: [{
                    runId, callId, backendId: 'claude', status: 'failed', hasOutput: false, reviewOutcome: 'unavailable',
                }] },
            });
            message.children.push({ kind: 'agent-text', id: 'narration', localId: null, createdAt: 3, text: 'Walkthrough ready.',
                meta: { happier: { kind: 'scm_diff_summary.v1', payload: narration } } });
            const presented = projectReviewToolMessage(message);

            expect(presented.tool.state).toBe(runId === 'review' && callId === 'review-call' ? 'error' : 'running');
            expect(presented.tool.result).toBeUndefined();
            expect(presented.meta).toBeUndefined();
            expect(message.tool.state).toBe('running');
        }
    });

    it('leaves absent, malformed, and foreign review output on the running parent unchanged', () => {
        for (const payload of [undefined, { ...findings, summary: null },
            { ...findings, runRef: { ...findings.runRef, runId: 'foreign' } },
            { ...findings, runRef: { ...findings.runRef, callId: 'foreign' } }]) {
            const message = parent(payload);
            expect(projectReviewToolMessage(message)).toBe(message);
        }
    });

    it('uses the latest published review outcome without rewriting the parent lifecycle or result', () => {
        const message = parent(findings);
        const failure = { ...findings, reviewOutcome: 'failed', summary: 'Review incomplete.', generatedAtMs: 3 };
        message.children.push({ kind: 'agent-text', id: 'failed-findings', localId: null, createdAt: 3,
            text: failure.summary, meta: { happier: { kind: 'review_findings.v2', payload: failure } } });
        const presented = projectReviewToolMessage(message);

        expect(presented.tool.state).toBe('error');
        expect(presented.meta?.happier).toEqual({ kind: 'review_findings.v2', payload: failure });
        expect(presented.tool.result).toBeUndefined();
        expect(message.tool).toMatchObject({ state: 'running', completedAt: null });
        expect(message.meta).toBeUndefined();
    });
});
