import type { FileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

/** File identity and resource shape are shared by Session and Project panes. */
export function createWorkspaceFileDetailsTab(fullPath: string, anchor?: FileTargetAnchor, anchorSource?: ReviewCommentSource) {
    const fileName = fullPath.split(/[\\/]/).pop() ?? fullPath;
    return {
        key: `file:${fullPath}`,
        kind: 'file' as const,
        title: fileName,
        resource: { kind: 'file' as const, path: fullPath, ...(anchor ? { anchor } : {}), ...(anchorSource ? { anchorSource } : {}) },
    };
}
