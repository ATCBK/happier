import * as React from 'react';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';

/** Shared imperative entry for range-based Ask (including Problems), using the same draft store. */
export function upsertWorkspaceReviewCommentDraft(scope: WorkspaceScopeBase, draft: ReviewCommentDraft): void {
    storage.getState().upsertWorkspaceReviewCommentDraft(buildWorkspaceCacheKey(scope), draft);
}

export function useWorkspaceReviewCommentDraftHandlers(scope: WorkspaceScopeBase | null | undefined): Readonly<{
    onUpsertReviewCommentDraft: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft: (commentId: string) => void;
    clearReviewCommentDrafts: () => void;
    onReviewCommentError: (message: string) => void;
}> {
    const cacheKey = React.useMemo(() => {
        if (!scope) return null;
        try {
            return buildWorkspaceCacheKey(scope);
        } catch {
            return null;
        }
    }, [scope]);

    const onUpsertReviewCommentDraft = React.useCallback((draft: ReviewCommentDraft) => {
        if (!cacheKey || !scope) return;
        upsertWorkspaceReviewCommentDraft(scope, draft);
    }, [cacheKey, scope]);

    const onDeleteReviewCommentDraft = React.useCallback((commentId: string) => {
        if (!cacheKey) return;
        storage.getState().deleteWorkspaceReviewCommentDraft(cacheKey, commentId);
    }, [cacheKey]);

    const clearReviewCommentDrafts = React.useCallback(() => {
        if (!cacheKey) return;
        storage.getState().clearWorkspaceReviewCommentDrafts(cacheKey);
    }, [cacheKey]);

    const onReviewCommentError = React.useCallback((message: string) => {
        Modal.alert(t('common.error'), message);
    }, []);

    return { onUpsertReviewCommentDraft, onDeleteReviewCommentDraft, clearReviewCommentDrafts, onReviewCommentError };
}
