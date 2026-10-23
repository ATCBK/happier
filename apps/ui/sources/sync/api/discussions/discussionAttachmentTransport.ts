import { DISCUSSION_HTTP_PATHS_V1, DiscussionErrorResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionAttachmentReadInputV1Schema, DiscussionAttachmentReadResponseV1Schema,
    type DiscussionAttachmentReadInputV1 } from '@happier-dev/protocol/discussions/attachments';
import { DiscussionAttachmentUploadRequestV1Schema, DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1,
    type DiscussionAttachmentUploadRequestV1 } from '@happier-dev/protocol/discussions/attachmentsUpload';
import { BinaryBlobAccountEncryptionStageV1Schema, type BinaryBlobReferenceV1,
    type BinaryBlobStoredContentV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { DISCUSSION_UPLOAD_CONTENT_TYPE_V1, DISCUSSION_UPLOAD_PATH_V1, iterateDiscussionUploadFrameV1,
    type BinaryUploadSegmentV1 } from '@happier-dev/transfers';
import { decodeBase64 } from '@/encryption/base64';
import { hashBinaryContent, sealBinaryContent, type BinaryContentEncryption } from '@/sync/encryption/binaryContent';
import { readAttachmentFileBytes, type PreparedAttachmentSource } from '@/sync/domains/attachments/prepareAttachmentPayloads';
import { createBinaryUploadBody } from '@/sync/runtime/files/binaryUploadBody';
import { requestDiscussionHttp, type DiscussionHttpTransport } from './discussionHttp';

export type DiscussionAttachmentTransport = DiscussionHttpTransport;

function refuse(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }

export async function readDiscussionAttachmentTransportResponse(response: Response): Promise<unknown> {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = DiscussionErrorResponseV1Schema.safeParse(payload);
        throw refuse(parsed.success ? parsed.data.error : response.status === 404 ? 'unsupported_action' : 'outcome_unknown');
    }
    return payload;
}

/** All private resource uploads consume the same platform body/custody owner. */
export async function requestDiscussionAttachmentUpload(options: DiscussionAttachmentTransport,
    metadata: DiscussionAttachmentUploadRequestV1, segments: readonly BinaryUploadSegmentV1[], signal?: AbortSignal): Promise<unknown> {
    const upload = await createBinaryUploadBody(iterateDiscussionUploadFrameV1(metadata, segments), { signal, assertCurrent: options.assertCurrent });
    try {
        signal?.throwIfAborted();
        options.assertCurrent?.();
        const response = await requestDiscussionHttp(options, DISCUSSION_UPLOAD_PATH_V1, { method: 'POST',
            headers: { 'Content-Type': DISCUSSION_UPLOAD_CONTENT_TYPE_V1 }, body: upload.body, signal });
        const result = await readDiscussionAttachmentTransportResponse(response);
        options.assertCurrent?.();
        return result;
    } finally { await upload.dispose(); }
}

/** Sources are private invocation operands. Public HTTP callers supply the same admitted byte frame. */
export function prepareDiscussionAttachmentUpload(input: Readonly<{
    operation: 'create' | 'post' | 'reply';
    body: unknown;
    discussionId?: string;
    references: readonly BinaryBlobReferenceV1[];
    sources: readonly PreparedAttachmentSource[];
    mode: 'plain' | 'e2ee';
    encryption: BinaryContentEncryption | null;
    assertCurrent: () => void;
}>): Readonly<{ metadata: DiscussionAttachmentUploadRequestV1; segments: readonly BinaryUploadSegmentV1[] }> {
    if (input.references.length !== input.sources.length) throw refuse('attachment_source_unavailable');
    const sources = new Map(input.sources.map(source => [source.reference.blobId, source]));
    if (sources.size !== input.sources.length) throw refuse('attachment_source_unavailable');
    const t = input.mode === 'plain' ? 'plain' as const : 'encrypted' as const;
    const attachments = input.references.map(reference => ({ blobId: reference.blobId, t,
        storedSizeBytes: reference.sizeBytes + (input.mode === 'e2ee' ? DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1 : 0) }));
    const metadata = DiscussionAttachmentUploadRequestV1Schema.parse({ operation: input.operation,
        input: input.operation === 'create' ? input.body : { ...(typeof input.body === 'object' && input.body !== null ? input.body : {}), discussionId: input.discussionId }, attachments });
    const segments = input.references.map((reference, index): BinaryUploadSegmentV1 => ({
        storedSizeBytes: attachments[index]!.storedSizeBytes,
        bytes: (async function* () {
            input.assertCurrent();
            const selected = sources.get(reference.blobId);
            if (!selected || selected.reference.sizeBytes !== reference.sizeBytes || selected.reference.sha256 !== reference.sha256
                || selected.reference.mime !== reference.mime) throw refuse('attachment_source_changed');
            const bytes = await readAttachmentFileBytes(selected.source, { maxFileBytes: reference.sizeBytes, assertCurrent: input.assertCurrent });
            if (bytes.length !== reference.sizeBytes || hashBinaryContent(bytes) !== reference.sha256) throw refuse('attachment_source_changed');
            const content = await sealBinaryContent(bytes, input.mode, input.encryption);
            input.assertCurrent();
            yield decodeBase64(content.t === 'plain' ? content.v : content.c);
        })(),
    }));
    return { metadata, segments };
}

export async function readDiscussionAttachmentStoredContent(input: DiscussionAttachmentTransport & DiscussionAttachmentReadInputV1,
    signal?: AbortSignal) {
    const ids = DiscussionAttachmentReadInputV1Schema.parse({ discussionId: input.discussionId, messageId: input.messageId, blobId: input.blobId,
        ...(input.throughSeq === undefined ? {} : { throughSeq: input.throughSeq }) });
    input.assertCurrent?.();
    signal?.throwIfAborted();
    const path = DISCUSSION_HTTP_PATHS_V1.attachment.replace(':discussionId', encodeURIComponent(ids.discussionId))
        .replace(':messageId', encodeURIComponent(ids.messageId)).replace(':blobId', encodeURIComponent(ids.blobId));
    const suffix = ids.throughSeq === undefined ? '' : `?throughSeq=${ids.throughSeq}`;
    const value = DiscussionAttachmentReadResponseV1Schema.parse(await readDiscussionAttachmentTransportResponse(await input.request(`${path}${suffix}`, { method: 'GET', signal })));
    input.assertCurrent?.();
    signal?.throwIfAborted();
    if (value.blobId !== ids.blobId) throw refuse('discussion_content_unavailable');
    return value;
}

export async function stageDiscussionAttachmentAccountEncryptionConversion(input: DiscussionAttachmentTransport & Readonly<{
    discussionId: string; messageId: string; blobId: string; content: BinaryBlobStoredContentV1;
}>, signal?: AbortSignal) {
    const bytes = decodeBase64(input.content.t === 'plain' ? input.content.v : input.content.c);
    const stage = BinaryBlobAccountEncryptionStageV1Schema.parse(await requestDiscussionAttachmentUpload(input,
        DiscussionAttachmentUploadRequestV1Schema.parse({ operation: 'encryption-conversion',
            input: { discussionId: input.discussionId, messageId: input.messageId, blobId: input.blobId },
            attachments: [{ blobId: input.blobId, t: input.content.t, storedSizeBytes: bytes.length }] }),
        [{ storedSizeBytes: bytes.length, bytes }], signal));
    if (stage.t !== input.content.t || stage.contentSha256 !== hashBinaryContent(bytes)) throw refuse('discussion_content_unavailable');
    return stage;
}

export async function cancelDiscussionAttachmentAccountEncryptionConversion(input: DiscussionAttachmentTransport & Readonly<{ uploadId: string }>,
    signal?: AbortSignal): Promise<void> {
    input.assertCurrent?.();
    await readDiscussionAttachmentTransportResponse(await input.request(DISCUSSION_HTTP_PATHS_V1.attachmentUpload.replace(':uploadId', encodeURIComponent(input.uploadId)),
        { method: 'DELETE', signal }));
    input.assertCurrent?.();
}
