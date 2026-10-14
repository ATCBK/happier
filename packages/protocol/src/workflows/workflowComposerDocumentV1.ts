import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { MENTION_BOUNDS, MentionRefV1Schema } from '../runtime/input/mentionRefV1.js';
import { PortableComposerAttachmentV1Schema } from '../runtime/input/composerAttachmentV1.js';

/**
 * The saved, portable half of a Composer document: literal text, positionless
 * canonical references and contentless portable attachment records. A
 * transfer-owned staged-media claim is device-local and is deliberately not
 * durable definition content.
 */
export const WorkflowStepComposerDocumentSchema = lazyZodSchema(() => z.strictObject({
  text: z.string().check(z.minLength(1)),
  displayText: z.optional(z.string()),
  references: z._default(z.array(MentionRefV1Schema).check(z.maxLength(MENTION_BOUNDS.maxPerMessage)), []),
  attachments: z._default(z.array(PortableComposerAttachmentV1Schema), []),
}));
export type WorkflowStepComposerDocument = z.infer<typeof WorkflowStepComposerDocumentSchema>;
