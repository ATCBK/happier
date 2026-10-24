import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeDiscussionUploadMetadataV1, readBinaryUploadFrameV1 } from '@happier-dev/transfers';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { openResourceBinaryContent } from '@/api/encryption/resourceBinaryContent';
import { createDiscussionAttachmentFileReader, prepareDiscussionAttachmentUpload } from './discussionAttachmentUpload';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiscussionAttachmentBindingsV1 } from '@happier-dev/protocol/discussions/api';
import { deriveDiscussionMutationEqualityTagV1, serializeDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/discussions/equality';
import { sealSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import type { DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';

describe('captured Discussion attachment sources', () => {
  it('reads only exact bound Machine files on demand and rejects stale bytes through the existing transfer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-discussion-file-source-'));
    const path = join(directory, 'evidence.txt');
    const bytes = Buffer.from('original');
    const reference = { blobId: '7578de54-3f59-4d6d-8293-ff6e4682fd10', mime: 'text/plain', sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    try {
      const readAttachmentSource = createDiscussionAttachmentFileReader({ references: [reference], sources: [{ blobId: reference.blobId, path }] });
      // Selection binds names only: the OS file does not exist until the transfer demands it.
      await writeFile(path, bytes);
      expect(Buffer.from(await readAttachmentSource(reference.blobId))).toEqual(bytes);
      expect(() => createDiscussionAttachmentFileReader({ references: [reference], sources: [{ blobId: reference.blobId, path: 'relative.txt' }] }))
        .toThrow('discussion_attachment_source_invalid');
      await expect(readAttachmentSource('unselected')).rejects.toMatchObject({ code: 'discussion_attachment_source_invalid' });
      await writeFile(path, 'modified');
      const request = { discussionId: 'discussion', localId: 'original', mentionedAccountIds: [],
        content: { t: 'plain', v: { v: 1, parts: [{ t: 'attachment', attachment: { kind: 'file', id: reference.blobId, name: 'evidence.txt', file: reference } }] } },
        attachments: [{ blobId: reference.blobId, t: 'plain' }] };
      const prepared = prepareDiscussionAttachmentUpload({ operation: 'post', key: { mode: 'plain', dataKey: null, dataEncryptionKey: null },
        references: [reference], request, readAttachmentSource });
      await expect((async () => { for await (const _chunk of prepared.body) { /* Consume the actual upload. */ } })())
        .rejects.toMatchObject({ code: 'discussion_attachment_source_invalid' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('refuses absent or changed captured bytes rather than emitting a partial successful frame', async () => {
    const bytes = Buffer.from('original');
    const reference = { blobId: '7578de54-3f59-4d6d-8293-ff6e4682fd10', mime: 'text/plain', sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    const request = { discussionId: 'discussion', localId: 'original', content: { t: 'plain', v: { v: 1,
      parts: [{ t: 'attachment', attachment: { kind: 'file', id: reference.blobId, name: 'notes.txt', file: reference } }] } },
      mentionedAccountIds: [], mentionedSessionIds: [], attachments: [{ blobId: reference.blobId, t: 'plain' }] };
    const input = { operation: 'post' as const, request, references: [reference], key: { mode: 'plain' as const, dataKey: null, dataEncryptionKey: null } };
    expect(() => prepareDiscussionAttachmentUpload(input)).toThrow('discussion_attachment_source_unavailable');
    const prepared = prepareDiscussionAttachmentUpload({ ...input, readAttachmentSource: async () => Buffer.from('modified') });
    const consume = async () => { for await (const _chunk of prepared.body) { /* Consume the actual strict frame. */ } };
    await expect(consume()).rejects.toMatchObject({ code: 'discussion_attachment_source_invalid' });
  });
  it.each(['plain', 'e2ee'] as const)('seals exact captured leaves sequentially into the admitted %s mutation', async mode => {
    const bytes = [Buffer.from('first\0file'), Buffer.from([0, 255, 127, 128])];
    const references = bytes.map((file, index) => ({ blobId: `7578de54-3f59-4d6d-8293-ff6e4682fd1${index}`,
      mime: 'application/octet-stream', sizeBytes: file.byteLength, sha256: createHash('sha256').update(file).digest('hex') }));
    const key = mode === 'plain' ? { mode, dataKey: null, dataEncryptionKey: null } as const
      : { mode, dataKey: new Uint8Array(32).fill(7), dataEncryptionKey: 'captured-resource-envelope' } as const;
    const authored: DiscussionMessageContentV1 = { v: 1, parts: references.map((file, index) => ({
      t: 'attachment', attachment: { kind: 'file', id: file.blobId, name: `file-${index}.bin`, file },
    })) };
    const content = key.mode === 'plain' ? sealSessionStoredContent({ mode: 'plain', ctx: null, payload: authored })
      : sealSessionStoredContent({ mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' }, payload: authored });
    const bindings = buildDiscussionAttachmentBindingsV1(authored, content.t);
    const evidence = key.mode === 'e2ee' ? { requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: deriveDiscussionMutationEqualityTagV1({
      dataKey: key.dataKey, canonicalIntent: serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content: authored,
        mentionedAccountIds: [], mentionedSessionIds: [], ...bindings }),
    }) } } : {};
    const acquired: string[] = [];
    const prepared = prepareDiscussionAttachmentUpload({ operation: 'post', key, references,
      request: { discussionId: 'discussion', localId: 'original', content, mentionedAccountIds: [], mentionedSessionIds: [], ...bindings, ...evidence },
      readAttachmentSource: async blobId => { acquired.push(blobId); return bytes[references.findIndex(file => file.blobId === blobId)]!; },
    });
    expect(acquired).toEqual([]);
    const opened: Uint8Array[] = [];
    await readBinaryUploadFrameV1(prepared.body, { metadataMaxBytes: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
      decodeMetadata: decodeDiscussionUploadMetadataV1,
      onMetadata: async metadata => { expect(metadata.operation).toBe('post'); return metadata.attachments; },
      onSegment: async (index, chunks) => {
        const parts: Uint8Array[] = [];
        for await (const chunk of chunks) parts.push(chunk);
        const stored = Buffer.concat(parts);
        opened.push(await openResourceBinaryContent(key, references[index]!, mode === 'plain'
          ? { t: 'plain', v: stored.toString('base64') } : { t: 'encrypted', c: stored.toString('base64') }));
      },
    });
    expect(acquired).toEqual(references.map(file => file.blobId));
    expect(opened.map(file => Buffer.from(file))).toEqual(bytes);
    expect(JSON.stringify(prepared.metadata.attachments)).not.toContain('application/octet-stream');
    expect(JSON.stringify(prepared.metadata.attachments)).not.toContain(references[0]!.sha256);
  });
});
