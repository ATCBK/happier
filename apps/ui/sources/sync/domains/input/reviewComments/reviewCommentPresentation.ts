import { t } from '@/text';

import type { ReviewCommentDraft } from './reviewCommentTypes';
import { getReviewCommentDraftAnchorPrimaryLine } from './anchors/reviewCommentDraftAnchor';

export function getReviewCommentAnchorLine(draft: ReviewCommentDraft): number | null {
    return getReviewCommentDraftAnchorPrimaryLine(draft.anchor);
}

function anchorLineSpan(draft: ReviewCommentDraft): Readonly<{ start: number; end: number }> | null {
    const anchor = draft.anchor;
    if (anchor.kind === 'range') return { start: anchor.startLine, end: Math.max(anchor.startLine, anchor.endLine) };
    const line = getReviewCommentAnchorLine(draft);
    return line == null ? null : { start: line, end: line };
}

/** The anchored lines as a bare span ("9–11", "4"), for a chip that already names the file. */
export function formatReviewCommentAnchorLines(draft: ReviewCommentDraft): string | null {
    const span = anchorLineSpan(draft);
    if (!span) return null;
    return span.end > span.start ? `${span.start}–${span.end}` : `${span.start}`;
}

/**
 * Where a comment sits, as a person reads it ("Lines 9–11"; the old side of a change says so). The
 * line hashes and `L9-L11` form belong to the agent prompt (`formatReviewCommentDraftAnchorLabel`),
 * never to the UI.
 */
export function formatReviewCommentAnchorLabel(draft: ReviewCommentDraft): string {
    const span = anchorLineSpan(draft);
    const lines = !span
        ? ''
        : span.end > span.start
            ? t('files.reviewComments.anchorLines', span)
            : t('files.reviewComments.anchorLine', { line: span.start });
    return 'side' in draft.anchor && draft.anchor.side === 'before'
        ? t('files.reviewComments.anchorBeforeChange', { lines })
        : lines;
}
