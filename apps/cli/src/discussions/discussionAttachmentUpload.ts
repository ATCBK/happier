import type { BinaryBlobReferenceV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { DiscussionAttachmentUploadRequestV1Schema, DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1,
  type DiscussionAttachmentUploadRequestV1 } from '@happier-dev/protocol/discussions/attachmentsUpload';
import type { ResourceDataKey } from '@/api/encryption/resourceDataKey';
import { sealResourceBinaryContent } from '@/api/encryption/resourceBinaryContent';
import { decodeBase64 } from '@/api/encryption';
import { createHash } from 'node:crypto';
import { iterateDiscussionUploadFrameV1 } from '@happier-dev/transfers';

export type DiscussionAttachmentSourceReader = (blobId: string, signal?: AbortSignal) => Promise<Uint8Array>;

export function prepareDiscussionAttachmentUpload(input: Readonly<{
  operation: 'create' | 'post' | 'reply';
  request: unknown;
  references: readonly BinaryBlobReferenceV1[];
  key: ResourceDataKey;
  readAttachmentSource?: DiscussionAttachmentSourceReader;
  signal?: AbortSignal;
}>): Readonly<{ metadata: DiscussionAttachmentUploadRequestV1; body: AsyncIterable<Uint8Array> }> {
  const readSource = input.readAttachmentSource;
  if (!readSource) throw Object.assign(new Error('discussion_attachment_source_unavailable'), { code: 'discussion_attachment_source_unavailable' });
  const attachments = input.references.map(reference => ({ blobId: reference.blobId,
    t: input.key.mode === 'plain' ? 'plain' as const : 'encrypted' as const,
    storedSizeBytes: reference.sizeBytes + (input.key.mode === 'e2ee' ? DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1 : 0),
  }));
  const metadata = DiscussionAttachmentUploadRequestV1Schema.parse({ operation: input.operation, input: input.request, attachments });
  const segments = input.references.map((reference, index) => ({ storedSizeBytes: attachments[index]!.storedSizeBytes,
    bytes: (async function* () {
      input.signal?.throwIfAborted();
      const bytes = await readSource(reference.blobId, input.signal);
      input.signal?.throwIfAborted();
      if (bytes.byteLength !== reference.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
        throw Object.assign(new Error('discussion_attachment_source_invalid'), { code: 'discussion_attachment_source_invalid' });
      }
      const content = await sealResourceBinaryContent(input.key, bytes);
      input.signal?.throwIfAborted();
      yield decodeBase64(content.t === 'plain' ? content.v : content.c);
    })(),
  }));
  return { metadata, body: iterateDiscussionUploadFrameV1(metadata, segments) };
}
