import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export type AskSelectionSource = 'file' | 'diff' | 'markdown' | 'terminal' | 'transcript';

/** Rendered positions are not file lines unless the source renderer supplies that mapping. */
export function resolveAskSelectionAnchorSource(input: Readonly<{
    source: AskSelectionSource;
    filePath?: string;
    sourceLinesMapped?: boolean;
}>): ReviewCommentSource | null {
    if (!input.filePath) return null;
    if (input.source === 'markdown' && input.sourceLinesMapped === true) return 'file';
    return input.source === 'file' || input.source === 'diff' ? input.source : null;
}
