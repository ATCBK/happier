import type { FileDisplayMode } from '@/components/workspaces/files/file/filePageModel';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export function resolveFileDetailsDisplayMode(input: Readonly<{
    requestedMode?: FileDisplayMode | null;
    persistedEditing: boolean;
    deepLinkSource: ReviewCommentSource | null;
    hasRenderableDiff: boolean;
    hasFileContent: boolean;
    markdownPreviewAvailable: boolean;
    /** The tree / SCM already says this file changed, so its diff is on the way. */
    knownChanged?: boolean;
    /** A Markdown file: it waits on its Preview, so the segment doesn't jump when the text arrives. */
    previewKind?: boolean;
}>): FileDisplayMode {
    if (input.requestedMode) return input.requestedMode;
    if (input.deepLinkSource === 'file') return 'file';
    if (input.deepLinkSource === 'diff' && input.hasRenderableDiff) return 'diff';
    if (input.persistedEditing) return 'file';
    if (input.hasRenderableDiff) return 'diff';
    if (input.markdownPreviewAvailable) return 'markdown';
    if (input.hasFileContent) return 'file';
    // Nothing held yet (loading, or too large to hold): a changed file waits for its diff in Changes; any other
    // file waits in View, where its loading and too-large states live (lab FV1l, FV2).
    return input.knownChanged ? 'diff' : input.previewKind ? 'markdown' : 'file';
}
