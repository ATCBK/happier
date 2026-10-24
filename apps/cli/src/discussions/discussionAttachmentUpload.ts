import type { BinaryBlobReferenceV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { DiscussionAttachmentUploadRequestV1Schema, DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1,
  type DiscussionAttachmentUploadRequestV1 } from '@happier-dev/protocol/discussions/attachmentsUpload';
import type { ResourceDataKey } from '@/api/encryption/resourceDataKey';
import { sealResourceBinaryContent } from '@/api/encryption/resourceBinaryContent';
import { decodeBase64 } from '@/api/encryption';
import { createHash } from 'node:crypto';
import { iterateDiscussionUploadFrameV1 } from '@happier-dev/transfers';
import type { DiscussionAttachmentSourceV1 } from '@happier-dev/protocol/discussions/attachments';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

export type DiscussionAttachmentSourceReader = (blobId: string, signal?: AbortSignal) => Promise<Uint8Array>;

/** Bind only the message's selected leaves; no filesystem work happens until transfer demand. */
export function createDiscussionAttachmentFileReader(input: Readonly<{
  references: readonly BinaryBlobReferenceV1[];
  sources: readonly DiscussionAttachmentSourceV1[];
}>): DiscussionAttachmentSourceReader {
  const invalid = () => Object.assign(new Error('discussion_attachment_source_invalid'), { code: 'discussion_attachment_source_invalid' });
  const paths = new Map(input.sources.map(source => [source.blobId, expandHomeDirPath(source.path)]));
  const sizes = new Map(input.references.map(reference => [reference.blobId, reference.sizeBytes]));
  if (paths.size !== input.sources.length || paths.size !== input.references.length
    || input.references.some(reference => !paths.has(reference.blobId))
    || [...paths.values()].some(path => !isAbsolute(path))) throw invalid();
  return async (blobId, signal) => {
    const path = paths.get(blobId);
    const sizeBytes = sizes.get(blobId);
    if (!path || sizeBytes === undefined) throw invalid();
    signal?.throwIfAborted();
    // The existing declared transfer size bounds intake before allocating file bytes.
    const file = await stat(path);
    if (!file.isFile() || file.size !== sizeBytes) throw invalid();
    return await readFile(path, { signal });
  };
}

export function prepareDiscussionAttachmentUpload(input: Readonly<{
  operation: 'create' | 'post' | 'reply';
  request: unknown;
  references: readonly BinaryBlobReferenceV1[];
  key: ResourceDataKey;
  readAttachmentSource?: DiscussionAttachmentSourceReader;
  /** Host attestation runs after framing is known, before any bytes are read. */
  bindAgent?: (metadata: DiscussionAttachmentUploadRequestV1) => NonNullable<Exclude<DiscussionAttachmentUploadRequestV1,
    { operation: 'encryption-conversion' }>['agent']>;
  signal?: AbortSignal;
}>): Readonly<{ metadata: DiscussionAttachmentUploadRequestV1; body: AsyncIterable<Uint8Array> }> {
  const readSource = input.readAttachmentSource;
  if (!readSource) throw Object.assign(new Error('discussion_attachment_source_unavailable'), { code: 'discussion_attachment_source_unavailable' });
  const attachments = input.references.map(reference => ({ blobId: reference.blobId,
    t: input.key.mode === 'plain' ? 'plain' as const : 'encrypted' as const,
    storedSizeBytes: reference.sizeBytes + (input.key.mode === 'e2ee' ? DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1 : 0),
  }));
  const unsigned = DiscussionAttachmentUploadRequestV1Schema.parse({ operation: input.operation, input: input.request, attachments });
  const metadata = input.bindAgent ? DiscussionAttachmentUploadRequestV1Schema.parse({ ...unsigned, agent: input.bindAgent(unsigned) }) : unsigned;
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
