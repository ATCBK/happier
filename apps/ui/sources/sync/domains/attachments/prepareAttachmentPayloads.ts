import { StoredAttachmentPayloadV1Schema,
    type StoredAttachmentPayloadV1 } from '@happier-dev/protocol/transfers/attachments/attachmentPayloadV1';
import { AttachmentNameV1Schema, normalizeAttachmentRelativePathV1 } from '@happier-dev/protocol/transfers/attachments/attachmentPathV1';
import type { BinaryBlobReferenceV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import type { AttachmentsUploadFileSource, AttachmentUploadSource } from './attachmentsUploadFileSource';
import { describeAttachmentUploadFileSource } from './attachmentsUploadFileSource';
import { openLocalUploadSourceReader } from '@/sync/runtime/files/localUploadSourceReader';
import { hashBinaryContent } from '@/sync/encryption/binaryContent';
import { randomUUID } from '@/platform/randomUUID';
import { HappyError } from '@/utils/errors/errors';

export type PreparedAttachmentSource = Readonly<{ reference: BinaryBlobReferenceV1; source: AttachmentsUploadFileSource }>;
export type PreparedAttachmentPayloads = Readonly<{
    attachments: readonly StoredAttachmentPayloadV1[];
    sources: readonly PreparedAttachmentSource[];
}>;

/** Captures environment sources under the existing tray identity, without uploading. */
export async function prepareAttachmentPayloads(input: Readonly<{
    drafts: readonly Readonly<{ id: string; source: AttachmentUploadSource }>[];
    maxFileBytes: number;
    previous?: readonly StoredAttachmentPayloadV1[];
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): Promise<PreparedAttachmentPayloads> {
    const attachments: StoredAttachmentPayloadV1[] = [];
    const sources: PreparedAttachmentSource[] = [];
    const assertCurrent = () => {
        if (input.signal?.aborted || input.isCurrent?.() === false) throw new HappyError('Attachment preparation canceled', false, { code: 'canceled' });
    };
    assertCurrent();
    for (const draft of input.drafts) {
        const retainedPayload = input.previous?.find(attachment => attachment.id === draft.id);
        const previous = retainedPayload === undefined ? undefined : StoredAttachmentPayloadV1Schema.parse(retainedPayload);
        const source = draft.source;
        const name = AttachmentNameV1Schema.parse((source.kind === 'folder' ? source.name : describeAttachmentUploadFileSource(source).name).normalize('NFC'));
        const prepareFile = async (file: AttachmentsUploadFileSource, retained?: BinaryBlobReferenceV1): Promise<BinaryBlobReferenceV1> => {
            const bytes = await readAttachmentFileBytes(file, { maxFileBytes: input.maxFileBytes, assertCurrent });
            const mime = describeAttachmentUploadFileSource(file).mimeType;
            const reference = { blobId: retained?.blobId ?? (source.kind === 'folder' ? randomUUID() : draft.id),
                mime: mime || 'application/octet-stream', sizeBytes: bytes.byteLength, sha256: hashBinaryContent(bytes) };
            if (retained && JSON.stringify(reference) !== JSON.stringify(retained)) throw new HappyError('Attachment source changed', false, { code: 'attachment_source_changed' });
            sources.push({ reference, source: file });
            return reference;
        };
        let attachment: StoredAttachmentPayloadV1;
        if (source.kind === 'folder') {
            const entries = [];
            for (const entry of source.entries) {
                const relativePath = normalizeAttachmentRelativePathV1(entry.relativePath);
                if (!relativePath) throw new HappyError('Invalid attachment relative path', false, { code: 'attachment_source_unavailable' });
                const retained = previous?.kind === 'folder' ? previous.entries.find(value => value.relativePath === relativePath)?.file : undefined;
                entries.push({ relativePath, file: await prepareFile(entry.source, retained) });
            }
            attachment = StoredAttachmentPayloadV1Schema.parse({ kind: 'folder', id: draft.id, name, entries,
                directories: (source.directories ?? []).map(path => {
                    const normalized = normalizeAttachmentRelativePathV1(path);
                    if (!normalized) throw new HappyError('Invalid attachment directory path', false, { code: 'attachment_source_unavailable' });
                    return normalized;
                }) });
        } else {
            attachment = StoredAttachmentPayloadV1Schema.parse({ kind: 'file', id: draft.id, name,
                file: await prepareFile(source, previous?.kind === 'file' ? previous.file : undefined) });
        }
        if (previous && JSON.stringify(attachment) !== JSON.stringify(previous)) throw new HappyError('Attachment source changed', false, { code: 'attachment_source_changed' });
        attachments.push(attachment);
    }
    assertCurrent();
    return { attachments, sources };
}

/** The platform file reader owns web/native/memory IO; no Machine is needed. */
export async function readAttachmentFileBytes(source: AttachmentsUploadFileSource,
    options: Readonly<{ maxFileBytes?: number; assertCurrent?: () => void }> = {}): Promise<Uint8Array> {
    options.assertCurrent?.();
    const reader = await openLocalUploadSourceReader(source);
    try {
        options.assertCurrent?.();
        const size = reader.sizeBytes;
        if (size === null || !Number.isSafeInteger(size) || size < 0) throw new HappyError('Attachment size is unavailable', false, { code: 'attachment_source_unavailable' });
        if (options.maxFileBytes !== undefined && size > options.maxFileBytes) throw new HappyError('Attachment exceeds selected size limit', false, { code: 'attachment_too_large' });
        const bytes = await reader.readBytes(0, size);
        options.assertCurrent?.();
        if (bytes.byteLength !== size) throw new HappyError('Attachment source was interrupted', false, { code: 'attachment_source_unavailable' });
        return bytes;
    } finally { await reader.close(); }
}
