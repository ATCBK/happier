import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import {
    clearAttachmentDraftsForKey,
    clearAttachmentDraftsForKeyPrefix,
    readAttachmentDraftsForKey,
    writeAttachmentDraftsForKey,
    settleAttachmentDraftsForKey,
    subscribeAttachmentDraftsForKey,
} from '@/components/sessions/attachments/attachmentDraftMemoryStore';

const NEW_SESSION_ATTACHMENT_DRAFT_KEY_PREFIX = 'new-session:';

function normalizeFlowId(flowId: string | null | undefined): string | null {
    if (typeof flowId !== 'string') return null;
    const trimmed = flowId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function newSessionAttachmentDraftKey(flowId: string): string {
    return `${NEW_SESSION_ATTACHMENT_DRAFT_KEY_PREFIX}${flowId}`;
}

export function readNewSessionAttachmentDrafts(flowId: string | null | undefined): readonly AttachmentDraft[] {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return [];

    return readAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId));
}

export function writeNewSessionAttachmentDrafts(
    flowId: string | null | undefined,
    drafts: readonly AttachmentDraft[],
): void {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return;

    writeAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId), drafts);
}

export function clearNewSessionAttachmentDrafts(flowId: string | null | undefined): void {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return;
    clearAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId));
}

/** Mounted composers release their own sources when the draft owner removes the flow. */
export function subscribeNewSessionAttachmentDraftRemoval(flowId: string, onRemoved: () => void): () => void {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return () => {};
    return subscribeAttachmentDraftsForKey(newSessionAttachmentDraftKey(normalizedFlowId), event => {
        if (event === 'cleared') onRemoved();
    });
}

/** Accepted custody settles the detached Send, not files added to its successor draft. */
export function clearAcceptedNewSessionAttachmentDrafts(
    flowId: string | null | undefined,
    acceptedDrafts: readonly AttachmentDraft[],
): readonly AttachmentDraft[] {
    const normalizedFlowId = normalizeFlowId(flowId);
    if (!normalizedFlowId) return [];
    const key = newSessionAttachmentDraftKey(normalizedFlowId);
    return settleAttachmentDraftsForKey(key, acceptedDrafts);
}

export function clearAllNewSessionAttachmentDrafts(): void {
    clearAttachmentDraftsForKeyPrefix(NEW_SESSION_ATTACHMENT_DRAFT_KEY_PREFIX);
}
