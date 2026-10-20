import { isExecutionRunActive, type ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ReviewFindingsV1 } from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import type { ReviewFindingsV2 } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import type { ScmDiffSummaryReviewRun } from '@happier-dev/protocol/scm/diffSummary';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { ReviewOverlayFinding } from '@happier-dev/protocol/reviews/projectReviewFindingsOverlay';

/** Findings describe the review phase even when its retained Run is writing a later turn. */
export function readReviewOutcome(payload: ReviewFindingsV1 | ReviewFindingsV2 | null | undefined): ReviewFindingsV2['reviewOutcome'] | null {
    const outcome = payload && 'reviewOutcome' in payload ? payload.reviewOutcome : null;
    return outcome === 'complete' || outcome === 'partial' || outcome === 'failed' ? outcome : null;
}

/** A failed refresh cannot withdraw a publication or turn an unavailable inventory into a review outcome. */
export function resolveReviewRunOutput(params: Readonly<{
    payload?: ReviewFindingsV1 | ReviewFindingsV2 | null;
    recorded?: ScmDiffSummaryReviewRun | null;
    comments?: Readonly<{ status: 'idle' | 'loading' | 'loaded' | 'failed'; comments: readonly ReviewCommentV1[] }>;
}>): Readonly<{
    hasOutput: boolean;
    reviewOutcome?: ScmDiffSummaryReviewRun['reviewOutcome'];
    readState: 'ready' | 'loading' | 'unavailable';
    findings: readonly ReviewOverlayFinding[];
}> {
    const { payload, recorded } = params;
    if (payload) {
        const reviewOutcome = readReviewOutcome(payload) ?? recorded?.reviewOutcome;
        return { hasOutput: true, findings: payload.findings, readState: 'ready', ...(reviewOutcome ? { reviewOutcome } : {}) };
    }
    if (recorded?.hasOutput && recorded.materialization?.kind === 'complete' && recorded.commentIds) {
        if (recorded.commentIds.length === 0) return { hasOutput: true, findings: [], readState: 'ready', reviewOutcome: recorded.reviewOutcome };
        const snapshot = params.comments;
        if (!snapshot || snapshot.status === 'idle' || snapshot.status === 'loading') return { hasOutput: false, findings: [], readState: 'loading' };
        const byId = new Map(snapshot.comments.map((comment) => [comment.id, comment]));
        const findings = recorded.commentIds.map((id): ReviewOverlayFinding | null => {
            const comment = byId.get(id);
            if (!comment?.findingId || !comment.findingSeverity || comment.parentCommentId
                || comment.tombstone || comment.flags.redacted || typeof comment.body !== 'string' || !comment.body.trim()) return null;
            const paragraphs = comment.body.split('\n\n');
            const title = paragraphs.shift() ?? comment.body;
            const { anchor } = comment;
            return { id: comment.findingId, title, severity: comment.findingSeverity,
                summary: paragraphs.join('\n\n') || title,
                ...('filePath' in anchor ? { filePath: anchor.filePath } : {}),
                ...(anchor.kind === 'line' ? { startLine: anchor.line, endLine: anchor.line }
                    : anchor.kind === 'range' ? { startLine: anchor.startLine, endLine: anchor.endLine } : {}),
                comment: { id: comment.id, state: comment.state, serverRevision: comment.serverRevision,
                    ...(comment.projectId ? { projectId: comment.projectId } : {}), ...(comment.workspace ? { workspace: comment.workspace } : {}),
                    ...(comment.sessionId ? { sessionId: comment.sessionId } : {}), ...(comment.runId ? { runId: comment.runId } : {}) },
            } satisfies ReviewOverlayFinding;
        });
        const available = findings.filter((finding) => finding !== null);
        if (snapshot.status !== 'loaded' || findings.some((finding) => finding === null)) {
            return { hasOutput: false, findings: available, readState: 'unavailable' };
        }
        return { hasOutput: true, findings: available, readState: 'ready', reviewOutcome: recorded.reviewOutcome };
    }
    if (params.comments?.status === 'failed') {
        return { hasOutput: false, findings: [], readState: 'unavailable' };
    }
    return { hasOutput: false, findings: [], readState: 'ready', reviewOutcome: recorded?.reviewOutcome === 'failed' ? 'failed' : 'partial' };
}

/** Review completion is separate from the lifetime of the resumable Run that produced it. */
export function resolveReviewRunStatus(params: Readonly<{
    run?: ExecutionRunPublicState | null;
    payload?: ReviewFindingsV1 | ReviewFindingsV2 | null;
    recorded?: ScmDiffSummaryReviewRun | null;
}>): ExecutionRunPublicState['status'] | undefined {
    const outcome = readReviewOutcome(params.payload) ?? params.recorded?.reviewOutcome;
    if (outcome === 'complete' || outcome === 'partial') return 'succeeded';
    if (outcome === 'failed' || outcome === 'unavailable') return 'failed';
    if (params.recorded && params.recorded.status !== 'running') return params.recorded.status;
    const { run } = params;
    if (run && run.status !== 'running') return run.status;
    if (run && !isExecutionRunActive(run)) {
        const turn = run.inputTurns?.current ?? run.inputTurns?.last;
        if (turn?.state === 'completed') return 'succeeded';
        if (turn?.state === 'failed' || turn?.state === 'cancelled') return turn.state;
    }
    return run?.status ?? params.recorded?.status;
}
