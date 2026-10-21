import { createSessionAccessActionChip } from '@/components/sessions/agentInput/definitions/createSessionAccessActionChip';
import * as React from 'react';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol';

import type {
    AgentInputAttachmentsRowItem,
    AgentInputExtraActionChip,
} from '@/components/sessions/agentInput/agentInputContracts';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { BrowserContextState } from '@/sync/domains/browser/context';
import { hasBrowserContextComposerAttachments } from '@/sync/domains/session/input/browserContext';
import { storage } from '@/sync/domains/state/storage';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { createLinkedFilesActionChip } from '../definitions/createLinkedFilesActionChip';
import { createBrowserContextActionChip } from '../definitions/createBrowserContextActionChip';
import { createReviewCommentsActionChip } from '../definitions/createReviewCommentsActionChip';
import { buildSessionAgentInputActionChips } from './buildSessionAgentInputActionChips';
import { createAttachmentActionChip } from './createAttachmentActionChip';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export function useSessionAgentInputExtraActionChips(params: Readonly<{
    sessionAccess?: Parameters<typeof createSessionAccessActionChip>[0] | null;
    sessionId: string;
    sessionAddress: SessionAddress | null;
    accountScope: ServerAccountScope | null;
    accountScopeIsCurrent?: (() => boolean) | null;
    attachmentsUploadsEnabled: boolean;
    attachmentsUploadsAvailable?: boolean;
    isReadOnly: boolean;
    isUploadingAttachments: boolean;
    onPickAttachmentFile: () => void;
    onPickAttachmentImage: () => void;
    onPasteAttachmentImage?: () => void;
    onAppendLinkedPath: (path: string) => void;
    reviewCommentsEnabled: boolean;
    reviewScope: WorkspaceScopeBase | null;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    defaultBackendTarget?: BackendTargetRefV2Input | null;
    defaultBackendId: string | null;
    /** The composer text, read when an action chip is pressed. */
    readInstructionsText: () => string;
    browserContext?: Readonly<{
        state: BrowserContextState;
        onAttachPageReference?: () => void;
        onRemoveAttachment?: (attachmentId: string) => void;
        disabledReason?: string | null;
    }> | null;
}>): Readonly<{
    actionChips: readonly AgentInputExtraActionChip[];
    attachmentRowItems: readonly AgentInputAttachmentsRowItem[];
}> {
    const { open: openFile, canOpen: canOpenFile } = useWorkspaceFileOpener();
    const reviewWorkspaceCacheKey = React.useMemo(() => (
        params.reviewScope ? tryBuildWorkspaceCacheKey(params.reviewScope) : null
    ), [params.reviewScope]);

    return React.useMemo(() => {
        const chips: AgentInputExtraActionChip[] = [];
        if (params.sessionAccess) chips.push(createSessionAccessActionChip(params.sessionAccess));
        const attachmentRowItems: AgentInputAttachmentsRowItem[] = [];

        if (params.attachmentsUploadsEnabled && !params.isReadOnly) {
            chips.push(createAttachmentActionChip({
                onPickFile: params.onPickAttachmentFile,
                onPickImage: params.onPickAttachmentImage,
                onPasteImage: params.onPasteAttachmentImage,
                disabled: params.isUploadingAttachments || params.attachmentsUploadsAvailable === false,
            }));
        }

        if (!params.isReadOnly) {
            chips.push(createLinkedFilesActionChip({
                sessionId: params.sessionId,
                serverId: params.sessionAddress?.serverId,
                disabled: params.isUploadingAttachments,
                onPickPath: params.onAppendLinkedPath,
            }));
        }

        const browserContext = params.browserContext;
        if (browserContext && hasBrowserContextComposerAttachments(browserContext.state)) {
            const browserContextPresentation = createBrowserContextActionChip(browserContext);
            chips.push(browserContextPresentation.actionChip);
            if (browserContextPresentation.attachmentRowItem) {
                attachmentRowItems.push(browserContextPresentation.attachmentRowItem);
            }
        }

        if (params.reviewCommentsEnabled) {
            const reviewCommentsPresentation = createReviewCommentsActionChip({
                sessionId: params.sessionId,
                openFile: canOpenFile ? openFile : undefined,
                reviewScope: params.reviewScope,
                reviewCommentDrafts: params.reviewCommentDrafts,
                onSetDraftIncluded: (draftId, included) => {
                    if (reviewWorkspaceCacheKey) {
                        storage.getState().setWorkspaceReviewCommentDraftIncluded(reviewWorkspaceCacheKey, draftId, included);
                    } else {
                        storage.getState().setSessionReviewCommentDraftIncluded(params.sessionId, draftId, included);
                    }
                },
                onUpdateDraft: (draft) => {
                    if (reviewWorkspaceCacheKey) {
                        storage.getState().upsertWorkspaceReviewCommentDraft(reviewWorkspaceCacheKey, draft);
                    } else {
                        storage.getState().upsertSessionReviewCommentDraft(params.sessionId, draft);
                    }
                },
                onDeleteDraft: (draftId) => {
                    if (reviewWorkspaceCacheKey) {
                        storage.getState().deleteWorkspaceReviewCommentDraft(reviewWorkspaceCacheKey, draftId);
                    } else {
                        storage.getState().deleteSessionReviewCommentDraft(params.sessionId, draftId);
                    }
                },
                onClearDrafts: () => {
                    if (reviewWorkspaceCacheKey) {
                        storage.getState().clearWorkspaceReviewCommentDrafts(reviewWorkspaceCacheKey);
                    } else {
                        storage.getState().clearSessionReviewCommentDrafts(params.sessionId);
                    }
                },
            });
            if (reviewCommentsPresentation) {
                chips.push(reviewCommentsPresentation.actionChip);
                if (reviewCommentsPresentation.attachmentRowItem) {
                    attachmentRowItems.push(reviewCommentsPresentation.attachmentRowItem);
                }
            }
        }

        chips.push(...buildSessionAgentInputActionChips({
            address: params.sessionAddress ?? { serverId: '', sessionId: params.sessionId },
            accountScope: params.accountScope,
            accountScopeIsCurrent: params.accountScopeIsCurrent,
            defaultBackendTarget: params.defaultBackendTarget ?? null,
            defaultBackendId: params.defaultBackendId,
            readInstructionsText: params.readInstructionsText,
        }));

        return { actionChips: chips, attachmentRowItems };
    }, [
        canOpenFile,
        openFile,
        params.sessionAccess,
        params.attachmentsUploadsEnabled,
        params.attachmentsUploadsAvailable,
        params.defaultBackendId,
        params.defaultBackendTarget,
        params.readInstructionsText,
        params.isReadOnly,
        params.isUploadingAttachments,
        params.onAppendLinkedPath,
        params.onPickAttachmentFile,
        params.onPickAttachmentImage,
        params.onPasteAttachmentImage,
        params.reviewCommentDrafts,
        params.reviewCommentsEnabled,
        params.reviewScope,
        params.sessionId,
        params.sessionAddress,
        params.accountScope,
        params.accountScopeIsCurrent,
        params.browserContext,
        reviewWorkspaceCacheKey,
    ]);
}
