import { z } from 'zod/mini';
import { SessionAttachmentHandleV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';

export const AttachmentMessageMetaItemV1Schema = z.object({
    id: z.optional(z.string()),
    name: z.string(),
    path: z.string(),
    mimeType: z.optional(z.string()),
    sizeBytes: z.number(),
    sha256: z.optional(z.string()),
    attachmentHandle: z.optional(SessionAttachmentHandleV1Schema),
});

export const AttachmentsMessageMetaV1Schema = z.object({
    attachments: z._default(z.array(AttachmentMessageMetaItemV1Schema), []),
});

export type AttachmentsMessageMetaV1 = z.infer<typeof AttachmentsMessageMetaV1Schema>;
