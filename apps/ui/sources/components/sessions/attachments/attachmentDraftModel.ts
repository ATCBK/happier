import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol';
import type { AttachmentTargetUploadedDraftCheckpoint } from './uploadAttachmentDraftsToSession';

export type AttachmentDraftStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export type AttachmentDraft = Readonly<{
    id: string;
    source: AttachmentsUploadFileSource;
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
