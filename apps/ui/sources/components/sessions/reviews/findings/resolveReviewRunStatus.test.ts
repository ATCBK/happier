import { describe, expect, it } from 'vitest';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import type { ScmDiffSummaryReviewRun } from '@happier-dev/protocol/scm/diffSummary';

import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { resolveReviewRunOutput } from './resolveReviewRunStatus';

const recorded: ScmDiffSummaryReviewRun = {
    runId: 'review-run', callId: 'review-call', backendId: 'claude', comparisonId: 'comparison',
    status: 'succeeded', hasOutput: true, reviewOutcome: 'complete',
    materialization: { kind: 'complete' }, commentIds: ['comment-1'],
};
const comment = ReviewCommentV1Schema.parse({
    ...buildReviewCommentFixture({ id: 'comment-1', runId: 'review-run', sessionId: 'session',
        body: 'Authorization is too broad\n\nOwners can delete another account’s documents.',
        anchor: { kind: 'line', filePath: 'access.ts', line: 4, side: 'after' } }),
    findingId: 'authorization', findingSeverity: 'high',
});

describe('saved Review publication when its Run is unreadable', () => {
    it('restores the complete findings from the exact durable inventory', () => {
        const output = resolveReviewRunOutput({ recorded, comments: { status: 'loaded', comments: [comment] } });
        expect(output).toMatchObject({ hasOutput: true, reviewOutcome: 'complete', readState: 'ready', findings: [{
            id: 'authorization', title: 'Authorization is too broad', severity: 'high',
            summary: 'Owners can delete another account’s documents.', filePath: 'access.ts', startLine: 4,
            comment: { id: 'comment-1' },
        }] });
        // A comment does not retain the original finding category. Do not invent one.
        expect(output.findings[0]).not.toHaveProperty('category');
    });

    it.each(['failed', 'loading', 'idle'] as const)('keeps a %s inventory unknown instead of partial or clean', (status) => {
        expect(resolveReviewRunOutput({ recorded, comments: { status, comments: [] } })).toMatchObject({
            hasOutput: false, readState: status === 'failed' ? 'unavailable' : 'loading',
        });
        expect(resolveReviewRunOutput({ recorded, comments: { status, comments: [] } }).reviewOutcome).toBeUndefined();
    });

    it('does not certify a missing referenced comment from an unrelated or partial inventory', () => {
        expect(resolveReviewRunOutput({ recorded, comments: { status: 'loaded', comments: [] } })).toMatchObject({
            hasOutput: false, readState: 'unavailable',
        });
    });

    it('keeps a failed inventory unknown when the saved publication has no exact inventory certificate', () => {
        const output = resolveReviewRunOutput({ recorded: { ...recorded, materialization: undefined, commentIds: undefined },
            comments: { status: 'failed', comments: [] } });
        expect(output).toMatchObject({ hasOutput: false, readState: 'unavailable' });
        expect(output.reviewOutcome).toBeUndefined();
    });

    it('retains a saved explicit zero-finding publication without depending on a comment read', () => {
        expect(resolveReviewRunOutput({ recorded: { ...recorded, commentIds: [] },
            comments: { status: 'failed', comments: [] } })).toMatchObject({
            hasOutput: true, reviewOutcome: 'complete', readState: 'ready', findings: [],
        });
    });
});
