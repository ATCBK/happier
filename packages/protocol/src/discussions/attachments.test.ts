import { describe, expect, it } from 'vitest';
import { buildDiscussionMutationRequestBodyV1, DiscussionPostRequestV1Schema } from './api.js';
import { DiscussionMessageContentV1Schema } from './content.js';
import { serializeDiscussionMutationEqualityIntentV1 } from './equality.js';
import { DiscussionAttachmentReadInputV1Schema, DiscussionAttachmentReadResponseV1Schema, DiscussionAttachmentReadResultV1Schema } from './attachments.js';
import { DiscussionAttachmentUploadRequestV1Schema, DiscussionAttachmentUploadSegmentV1Schema,
  DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1 } from './attachmentsUpload.js';
import { MAX_ATTACHMENT_UPLOAD_FILE_BYTES_V1 } from '../transfers/attachments/attachmentLimitsV1.js';
import { AttachmentRelativePathV1Schema } from '../transfers/attachments/attachmentPathV1.js';
import { getActionSpec } from '../actions/actionSpecs.js';

const blobId = '00000000-0000-4000-8000-000000000001';
const file = { blobId, mime: 'image/png', sizeBytes: 3, sha256: 'a'.repeat(64) };
const content = DiscussionMessageContentV1Schema.parse({ v: 1, parts: [
  { t: 'attachment', attachment: { kind: 'file', id: blobId, name: ' photo.png ', file } },
] });
const post = () => buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: 'post',
  content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] });

describe('Discussion attachment contracts', () => {
  it.each(['discussion.create', 'discussion.post', 'discussion.reply'] as const)('admits typed Machine-local sources at the public %s Action boundary', actionId => {
    const attachmentSources = [{ blobId, path: '/workspace/photo.png' }];
    const input = actionId === 'discussion.create' ? { title: 'Photo', firstMessage: { content }, attachmentSources }
      : { discussionId: 'discussion', content, attachmentSources,
        ...(actionId === 'discussion.reply' ? { replyTarget: { kind: 'message', messageId: 'parent' } } : {}) };
    expect(getActionSpec(actionId).inputSchema.safeParse(input).success).toBe(true);
    expect(getActionSpec(actionId).inputSchema.safeParse({ ...input,
      attachmentSources: [{ ...attachmentSources[0], accountId: 'forged' }] }).success).toBe(false);
    expect(getActionSpec(actionId).inputSchema.safeParse({ ...input,
      attachmentSources: [attachmentSources[0], attachmentSources[0]] }).success).toBe(false);
    expect(getActionSpec(actionId).inputSchema.safeParse({ ...input,
      attachmentSources: [{ blobId: '00000000-0000-4000-8000-000000000002', path: '/workspace/unselected.png' }] }).success).toBe(false);
  });
  it('keeps one typed tree per inline root identity while allowing repeated inline references', () => {
    const attachment = { kind: 'folder', id: blobId, name: 'Pictures', entries: [], directories: [] };
    const repeated = { v: 1, parts: [
      { t: 'attachment', attachment },
      { t: 'attachment', attachment: { ...attachment, name: 'Other pictures', directories: ['nested'] } },
    ] };
    expect(DiscussionMessageContentV1Schema.safeParse(repeated).success).toBe(false);
    const passage = { ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' },
      revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 3 }, quote: 'old' };
    expect(DiscussionMessageContentV1Schema.safeParse({ kind: 'doc_passage_comment', passage,
      content: { ...repeated, parts: [repeated.parts[0]] } }).success).toBe(true);
    expect(DiscussionMessageContentV1Schema.safeParse({ kind: 'doc_passage_comment', passage,
      content: repeated }).success).toBe(false);
    expect(DiscussionMessageContentV1Schema.safeParse({ v: 1, parts: [
      { t: 'text', text: `[Pictures](attachment:${blobId}) [again](attachment:${blobId})` },
      { t: 'attachment', attachment },
    ] }).success).toBe(true);
  });

  it('preserves Session filesystem name identity while rejecting nonrelative or noncanonical paths', () => {
    const decomposed = 'folder/cafe\u0301.png';
    expect(AttachmentRelativePathV1Schema.parse(decomposed)).toBe(decomposed);
    for (const path of ['../file', '/file', 'C:/file', '\\server\\file', 'folder\\file', 'folder//file', './file']) {
      expect(AttachmentRelativePathV1Schema.safeParse(path).success).toBe(false);
    }
  });
  it('derives exact immutable bindings at the canonical request builder and rejects substituted plain leaves', () => {
    const request = post();
    expect(request.attachments).toEqual([{ blobId, t: 'plain' }]);
    expect(DiscussionPostRequestV1Schema.safeParse({ ...request, attachments: [] }).success).toBe(false);
    expect(DiscussionPostRequestV1Schema.safeParse({ ...request, attachments: [{ blobId, t: 'encrypted' }] }).success).toBe(false);
    expect(DiscussionPostRequestV1Schema.safeParse({ ...request, attachments: [{ blobId, t: 'plain', sizeBytes: 3 }] }).success).toBe(false);
    expect(DiscussionMessageContentV1Schema.safeParse({ v: 1, parts: [{ t: 'attachment', attachment: {
      kind: 'file', id: '00000000-0000-4000-8000-000000000002', name: 'photo.png', file,
    } }] }).success).toBe(false);
    const empty = { v: 1 as const, parts: [{ t: 'attachment' as const, attachment: {
      kind: 'folder' as const, id: blobId, name: 'empty', entries: [], directories: ['empty-child'],
    } }] };
    expect(buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: 'empty', content: { t: 'plain', v: empty },
      authoredContent: empty, mentionedAccountIds: [] }).attachments).toBeUndefined();
  });

  it('binds upload segments to the same sealed request and leaves byte representation out of semantic equality', () => {
    const metadata = { operation: 'post', input: { ...post(), discussionId: 'discussion' },
      attachments: [{ blobId, t: 'plain', storedSizeBytes: 3 }] };
    expect(DiscussionAttachmentUploadRequestV1Schema.parse(metadata)).toEqual(metadata);
    expect(DiscussionAttachmentUploadRequestV1Schema.safeParse({ ...metadata, attachments: [...metadata.attachments, ...metadata.attachments] }).success).toBe(false);
    expect(DiscussionAttachmentUploadRequestV1Schema.safeParse({ ...metadata, attachments: [{ ...metadata.attachments[0], name: 'leak' }] }).success).toBe(false);
    expect(DiscussionAttachmentUploadRequestV1Schema.safeParse({ ...metadata, attachments: [{ ...metadata.attachments[0], blobId: '00000000-0000-4000-8000-000000000002' }] }).success).toBe(false);
    const bindings = [{ blobId, t: 'plain' as const }];
    const canonical = serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content, mentionedAccountIds: [], attachments: bindings });
    expect(canonical).not.toEqual(serializeDiscussionMutationEqualityIntentV1({ kind: 'post', content, mentionedAccountIds: [], attachments: [{ blobId, t: 'encrypted' }] }));
    const encrypted = { ...metadata, input: { ...metadata.input, content: { t: 'encrypted', c: 'ciphertext' },
      requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'a'.repeat(43) }, attachments: [{ blobId, t: 'encrypted' }] },
      attachments: [{ blobId, t: 'encrypted', storedSizeBytes: 32 }] };
    expect(DiscussionAttachmentUploadRequestV1Schema.safeParse(encrypted).success).toBe(true);
    expect(DiscussionAttachmentUploadRequestV1Schema.safeParse({ ...encrypted, attachments: metadata.attachments }).success).toBe(false);
  });

  it('preserves the configured maximum file boundary including existing encryption overhead', () => {
    for (const t of ['plain', 'encrypted'] as const) {
      const maximum = MAX_ATTACHMENT_UPLOAD_FILE_BYTES_V1 + (t === 'encrypted' ? DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1 : 0);
      expect(DiscussionAttachmentUploadSegmentV1Schema.safeParse({ blobId, t, storedSizeBytes: maximum }).success).toBe(true);
      expect(DiscussionAttachmentUploadSegmentV1Schema.safeParse({ blobId, t, storedSizeBytes: maximum + 1 }).success).toBe(false);
    }
    expect(DiscussionAttachmentUploadSegmentV1Schema.safeParse({ blobId, t: 'plain', storedSizeBytes: 0 }).success).toBe(true);
    expect(DiscussionAttachmentUploadSegmentV1Schema.safeParse({ blobId, t: 'encrypted', storedSizeBytes: DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1 }).success).toBe(true);
    expect(DiscussionAttachmentUploadSegmentV1Schema.safeParse({ blobId, t: 'encrypted', storedSizeBytes: DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1 - 1 }).success).toBe(false);
  });

  it('qualifies exact wire reads and distinguishes verified semantic bytes from stored envelopes', () => {
    const input = { discussionId: 'discussion', messageId: 'message', blobId, throughSeq: 4 };
    expect(DiscussionAttachmentReadInputV1Schema.parse(input)).toEqual(input);
    expect(DiscussionAttachmentReadInputV1Schema.safeParse({ ...input, path: '/tmp/forged' }).success).toBe(false);
    const wire = { blobId, content: { t: 'encrypted', c: 'Ynl0ZXM=' } };
    expect(DiscussionAttachmentReadResponseV1Schema.parse(wire)).toEqual(wire);
    expect(DiscussionAttachmentReadResultV1Schema.safeParse(wire).success).toBe(false);
    expect(DiscussionAttachmentReadResultV1Schema.parse({ ...file, bytesBase64: 'AP8K' })).toEqual({ ...file, bytesBase64: 'AP8K' });
  });

  it('stages conversion only for its one qualified immutable blob identity', () => {
    const metadata = { operation: 'encryption-conversion', input: { discussionId: 'discussion', messageId: 'message', blobId },
      attachments: [{ blobId, t: 'encrypted', storedSizeBytes: 32 }] };
    expect(DiscussionAttachmentUploadRequestV1Schema.safeParse(metadata).success).toBe(true);
    expect(DiscussionAttachmentUploadRequestV1Schema.safeParse({ ...metadata, attachments: [] }).success).toBe(false);
    expect(DiscussionAttachmentUploadRequestV1Schema.safeParse({ ...metadata, attachments: [{ ...metadata.attachments[0], blobId: '00000000-0000-4000-8000-000000000002' }] }).success).toBe(false);
  });
});
