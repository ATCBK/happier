import type { AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol';
import type { AttachmentTargetUploadedDraftCheckpoint } from './uploadAttachmentDraftsToSession';

export type AttachmentDraftStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export type AttachmentDraft = Readonly<{
    id: string;
    source: AttachmentUploadSource;
    status: AttachmentDraftStatus;
    error?: string;
    uploadProgress?: Readonly<{ uploadedBytes: number; totalBytes: number }>;
    uploadedPath?: string;
    uploadedSizeBytes?: number;
    uploadedMimeType?: string;
    sha256?: string;
    attachmentHandle?: SessionAttachmentHandleV1;
    /** Exact cross-Session upload checkpoints; ordinary uploadedPath remains source-scoped. */
    targetUploadedCheckpoints?: readonly AttachmentTargetUploadedDraftCheckpoint[];
}>;

export function sendableAttachmentDrafts(drafts: readonly AttachmentDraft[]): readonly AttachmentDraft[] {
    return drafts.filter(draft => draft.source.kind !== 'folder' || draft.status !== 'error');
}

/** Acceptance owns only the exact immutable source occurrence captured for Send. */
export function removeSubmittedAttachmentDrafts(current: readonly AttachmentDraft[], submitted: readonly AttachmentDraft[]): readonly AttachmentDraft[] {
    const sourcesById = new Map(submitted.map(draft => [draft.id, draft.source]));
    const remaining = current.filter(draft => sourcesById.get(draft.id) !== draft.source);
    return remaining.length === current.length ? current : remaining;
}
