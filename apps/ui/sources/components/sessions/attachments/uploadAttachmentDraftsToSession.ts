import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import { buildUploadedAttachment, type UploadedAttachment } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';

import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import { sessionAttachmentsUploadFile } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import type { AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { RpcError } from '@/sync/runtime/rpcErrors';
import { randomUUID } from '@/platform/randomUUID';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';
import { describeUploadFailure } from '@/components/transfers/describeUploadFailure';
import { classifyTransferFailure } from '@/sync/domains/transfers/runtime/transferRuntime';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime';
import type { SessionAttachmentsUploadFinalizeResponse, SessionAttachmentTransferContext } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';

import { sendableAttachmentDrafts, type AttachmentDraft } from './attachmentDraftModel';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';

export { buildUploadedAttachment, buildAttachmentMessageMeta, type UploadedAttachment } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';

export type AttachmentUploadedDraftCheckpoint = Readonly<{
    id: string;
    uploadedPath: string;
    uploadedSizeBytes: number;
    uploadedMimeType?: string;
    sha256?: string;
    attachmentHandle?: SessionAttachmentHandleV1;
}>;

export type AttachmentTargetUploadedDraftCheckpoint = AttachmentUploadedDraftCheckpoint & Readonly<{
    target: ExactSessionMachineTargetIdentity;
    executionTarget: SessionExecutionTargetV1;
    messageLocalId: string;
}>;

type UploadedAttachmentBase = Omit<UploadedAttachment, 'structuredInput'>;

export function describeAttachmentUploadSource(source: AttachmentUploadSource): Readonly<{
    name: string;
    mimeType?: string;
    sizeBytes?: number;
}> {
    if (source.kind === 'folder') {
        return { name: source.name, mimeType: source.mimeType,
            sizeBytes: source.entries.reduce((total, entry) => total + (describeAttachmentUploadSource(entry.source).sizeBytes ?? 0), 0) };
    }
    if (source.kind === 'web') {
        return {
            name: source.file.name,
            mimeType: source.file.type || undefined,
            sizeBytes: source.file.size,
        };
    }
    if (source.kind === 'memory') {
        return {
            name: source.name,
            mimeType: source.mimeType ? String(source.mimeType) : undefined,
            sizeBytes: source.bytes.byteLength,
        };
    }
    return {
        name: source.name,
        mimeType: source.mimeType ? String(source.mimeType) : undefined,
        sizeBytes: typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) ? source.sizeBytes : undefined,
    };
}

function createAttachmentUploadFailureError(input: Readonly<{
    error: string;
    errorCode?: string | null;
}>): Error {
    const normalizedCode = typeof input.errorCode === 'string' ? input.errorCode.trim() : '';
    return normalizedCode ? new RpcError(input.error, normalizedCode) : new Error(input.error);
}

export async function uploadAttachmentDraftsToSession(args: Readonly<{
    sessionId: string;
    /** Exact qualified Session target when the created Session is outside the active Account. */
    sessionTarget?: ExactSessionMachineTargetIdentity;
    transferContext?: SessionAttachmentTransferContext;
    drafts: readonly AttachmentDraft[];
    config: AttachmentsUploadConfig;
    applyDraftPatch: (id: string, patch: Partial<Omit<AttachmentDraft, 'id' | 'source'>>) => void;
    /**
     * Optional owner-level durability checkpoint. It is awaited before the next
     * file starts so a partial batch retry can reuse the verified remote path.
     */
    onUploadedDraftCheckpoint?: (draft: AttachmentUploadedDraftCheckpoint) => Promise<void> | void;
    messageLocalId?: string;
    signal?: AbortSignal | null;
    /** Genuine transfer boundary override for owner-level tests. */
    uploadFile?: typeof sessionAttachmentsUploadFile;
}>): Promise<Readonly<{
    messageLocalId: string;
    uploaded: readonly UploadedAttachment[];
}>> {
    const messageLocalId = args.messageLocalId ?? randomUUID();
    const uploaded: UploadedAttachment[] = [];

    for (const draft of sendableAttachmentDrafts(args.drafts)) {
        args.signal?.throwIfAborted();
        const stillPresent = args.drafts.find((d) => d.id === draft.id);
        if (!stillPresent) continue;

        const described = describeAttachmentUploadSource(stillPresent.source);
        if (stillPresent.uploadedPath) {
            const uploadedAttachment: UploadedAttachmentBase = {
                id: stillPresent.id,
                name: described.name,
                path: stillPresent.uploadedPath,
                sizeBytes: stillPresent.uploadedSizeBytes ?? described.sizeBytes ?? 0,
                ...((stillPresent.uploadedMimeType ?? described.mimeType)
                    ? { mimeType: (stillPresent.uploadedMimeType ?? described.mimeType)! }
                    : {}),
                ...(stillPresent.sha256 ? { sha256: stillPresent.sha256 } : {}),
                ...(stillPresent.attachmentHandle ? { attachmentHandle: stillPresent.attachmentHandle } : {}),
            };
            uploaded.push(buildUploadedAttachment(uploadedAttachment));
            continue;
        }

        const initialProgress =
            typeof described.sizeBytes === 'number' && Number.isFinite(described.sizeBytes) && described.sizeBytes >= 0
                ? { uploadedBytes: 0, totalBytes: described.sizeBytes }
                : undefined;
        args.applyDraftPatch(stillPresent.id, { status: 'uploading', error: undefined, uploadProgress: initialProgress });
        let uploadRes = await (args.uploadFile ?? sessionAttachmentsUploadFile)({
            sessionId: args.sessionId,
            ...(args.sessionTarget ? { sessionTarget: args.sessionTarget } : {}),
            ...(args.transferContext ? { transferContext: args.transferContext } : {}),
            file: stillPresent.source,
            ...(stillPresent.source.kind === 'folder' ? { folderUploadId: stillPresent.id } : {}),
            messageLocalId,
            config: args.config,
            signal: args.signal ?? undefined,
            onProgress: (progress) => {
                args.applyDraftPatch(stillPresent.id, { uploadProgress: progress });
            },
        });
        if (isTransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>(uploadRes)) {
            const recoveryResult = await runTransferFinalizeRecovery({
                recovery: uploadRes.recovery,
                signal: args.signal,
                title: t('transferRecovery.title'),
                message: t('transferRecovery.message'),
            });
            if (recoveryResult?.status === 'finalized') {
                uploadRes = recoveryResult.response;
            } else {
                uploadRes = {
                    success: false,
                    error: recoveryResult?.status === 'unavailable'
                        ? t('transferRecovery.unavailable')
                        : recoveryResult?.status === 'discarded'
                            ? t('transferRecovery.discarded')
                            : uploadRes.error,
                };
            }
        }
        args.signal?.throwIfAborted();
        if (!uploadRes.success) {
            args.applyDraftPatch(stillPresent.id, { status: 'error', error: stillPresent.source.kind === 'folder'
                ? describeUploadFailure(classifyTransferFailure(uploadRes), t('common.machine')) : uploadRes.error });
            throw createAttachmentUploadFailureError(uploadRes);
        }

        const uploadedPatch = {
            status: 'uploaded',
            uploadedPath: uploadRes.path,
            uploadedSizeBytes: uploadRes.sizeBytes,
            uploadedMimeType: described.mimeType,
            sha256: uploadRes.sha256,
            attachmentHandle: uploadRes.attachmentHandle,
            error: undefined,
            uploadProgress: { uploadedBytes: uploadRes.sizeBytes, totalBytes: uploadRes.sizeBytes },
        } satisfies Partial<Omit<AttachmentDraft, 'id' | 'source'>>;
        args.applyDraftPatch(stillPresent.id, uploadedPatch);
        await args.onUploadedDraftCheckpoint?.({
            id: stillPresent.id,
            uploadedPath: uploadRes.path,
            uploadedSizeBytes: uploadRes.sizeBytes,
            ...(described.mimeType ? { uploadedMimeType: described.mimeType } : {}),
            ...(uploadRes.sha256 ? { sha256: uploadRes.sha256 } : {}),
            ...(uploadRes.attachmentHandle ? { attachmentHandle: uploadRes.attachmentHandle } : {}),
        });

        const uploadedAttachment: UploadedAttachmentBase = {
            id: stillPresent.id,
            name: described.name,
            path: uploadRes.path,
            sizeBytes: uploadRes.sizeBytes,
            ...(described.mimeType ? { mimeType: described.mimeType } : {}),
            ...(uploadRes.sha256 ? { sha256: uploadRes.sha256 } : {}),
            ...(uploadRes.attachmentHandle ? { attachmentHandle: uploadRes.attachmentHandle } : {}),
        };
        uploaded.push(buildUploadedAttachment(uploadedAttachment));
    }

    return { messageLocalId, uploaded };
}
