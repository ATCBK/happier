import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SESSION_DATA_KEY_NONCE_BYTES, SESSION_DATA_KEY_TAG_BYTES } from '../crypto/sessionDataKeyBundleV0.js';
import { MAX_ATTACHMENT_UPLOAD_FILE_BYTES_V1 } from '../transfers/attachments/attachmentLimitsV1.js';
import { DiscussionCreateRequestV1Schema, DiscussionPostRequestV1Schema } from './api.js';
import { DiscussionAttachmentBindingV1Schema, DiscussionAttachmentReadRequestV1Schema } from './attachments.js';
import { DiscussionIdSchema } from './references.js';
import { DiscussionReplyTargetV1Schema } from './replyTargets.js';

/** Existing AES-GCM byte framing: version byte, nonce and authentication tag. */
export const DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1 = 1 + SESSION_DATA_KEY_NONCE_BYTES + SESSION_DATA_KEY_TAG_BYTES;

/** Clear metadata reveals structural lengths and ids only, never names/MIME/plaintext hashes. */
export const DiscussionAttachmentUploadSegmentV1Schema = lazyZodSchema(() => z.extend(DiscussionAttachmentBindingV1Schema, {
  storedSizeBytes: z.number().check(z.int(), z.nonnegative()),
}).check(z.refine(segment => segment.t === 'plain'
  ? segment.storedSizeBytes <= MAX_ATTACHMENT_UPLOAD_FILE_BYTES_V1
  : segment.storedSizeBytes >= DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1
    && segment.storedSizeBytes <= MAX_ATTACHMENT_UPLOAD_FILE_BYTES_V1 + DISCUSSION_ATTACHMENT_ENCRYPTED_OVERHEAD_BYTES_V1,
  'Attachment bytes exceed the supported per-file boundary or encrypted framing is incomplete')));
export type DiscussionAttachmentUploadSegmentV1 = z.infer<typeof DiscussionAttachmentUploadSegmentV1Schema>;

const segments = z.array(DiscussionAttachmentUploadSegmentV1Schema).check(z.refine(entries =>
  new Set(entries.map(entry => entry.blobId)).size === entries.length, 'Attachment upload blob ids must be unique'));
const postInput = lazyZodSchema(() => z.safeExtend(DiscussionPostRequestV1Schema, { discussionId: DiscussionIdSchema }));

/** Alternate byte representation of the same admitted storage mutation, not a second writer. */
export const DiscussionAttachmentUploadRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create'), input: DiscussionCreateRequestV1Schema, attachments: segments }),
  z.strictObject({ operation: z.literal('post'), input: postInput, attachments: segments }),
  z.strictObject({ operation: z.literal('reply'), input: z.safeExtend(postInput, { replyTarget: DiscussionReplyTargetV1Schema }), attachments: segments }),
  z.strictObject({ operation: z.literal('encryption-conversion'), input: DiscussionAttachmentReadRequestV1Schema, attachments: segments }),
]).check(z.superRefine((value, context) => {
  if (value.operation === 'encryption-conversion') {
    if (value.attachments.length !== 1 || value.attachments[0]?.blobId !== value.input.blobId) {
      context.addIssue({ code: 'custom', path: ['attachments'], message: 'Conversion stages exactly the qualified attachment' });
    }
    return;
  }
  const message = value.operation === 'create' ? value.input.firstMessage : value.input;
  const bindings = message.attachments ?? [];
  if (bindings.length !== value.attachments.length || value.attachments.some((segment, index) =>
    segment.blobId !== bindings[index]?.blobId || segment.t !== bindings[index]?.t || segment.t !== message.content.t)) {
    context.addIssue({ code: 'custom', path: ['attachments'], message: 'Ordered upload segments must match the exact message bindings and mode' });
  }
})));
export type DiscussionAttachmentUploadRequestV1 = z.infer<typeof DiscussionAttachmentUploadRequestV1Schema>;
