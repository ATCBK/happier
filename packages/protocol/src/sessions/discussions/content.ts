import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import { SessionIndexedIdentifierMaxLengthV1 } from '../idsV1.js';

const NO_OUTER_WHITESPACE_PATTERN = /^(?!\s)[\s\S]*\S$(?![\s\S])/u;

/**
 * Human discussion identifiers share the Session-indexed identifier bound
 * because they are stored in the same indexed string columns. This is the
 * existing persistence bound, not a new product limit.
 */
export const SessionDiscussionIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(SessionIndexedIdentifierMaxLengthV1), z.regex(NO_OUTER_WHITESPACE_PATTERN)));
export type SessionDiscussionId = z.infer<typeof SessionDiscussionIdSchema>;

export const SessionDiscussionMessageIdSchema = SessionDiscussionIdSchema;
export type SessionDiscussionMessageId = z.infer<typeof SessionDiscussionMessageIdSchema>;

/**
 * A client-chosen retry identity. It is bound to its authenticated author at
 * the mutation owner, so it is an identity for reconciliation and never an
 * authority to adopt another Account's result.
 */
export const SessionDiscussionLocalIdSchema = SessionDiscussionIdSchema;
export type SessionDiscussionLocalId = z.infer<typeof SessionDiscussionLocalIdSchema>;

export const SessionDiscussionAccountIdSchema = SessionDiscussionIdSchema;

function nfcString() {
  return z.string().check(z.refine((value) => value === value.normalize('NFC'), 'Session discussion text must be NFC-normalized'));
}

export const SessionDiscussionTitleV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  title: nfcString().check(z.refine((value) => value.trim().length > 0, 'A discussion title must not be blank')),
}));
export type SessionDiscussionTitleV1 = z.infer<typeof SessionDiscussionTitleV1Schema>;
export const SessionDiscussionTitleV1StoredSchema = createStoredReadSchema(SessionDiscussionTitleV1Schema);

export const SessionDiscussionMessagePartV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('text'), text: nfcString() }),
  z.strictObject({ t: z.literal('mention'), accountId: SessionDiscussionAccountIdSchema }),
]));
export type SessionDiscussionMessagePartV1 = z.infer<typeof SessionDiscussionMessagePartV1Schema>;

/**
 * The authored human document. A message must say something: at least one
 * mention or one non-blank text run. Adjacent empty text parts are rejected so
 * two clients cannot produce different bytes for the same visible message and
 * then disagree about request equality.
 */
export const SessionDiscussionMessageContentV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  parts: z.array(SessionDiscussionMessagePartV1Schema).check(z.minLength(1)),
}).check(z.superRefine((value, context) => {
  let hasMeaningfulPart = false;
  for (let index = 0; index < value.parts.length; index += 1) {
    const part = value.parts[index]!;
    if (part.t === 'mention') {
      hasMeaningfulPart = true;
      continue;
    }
    if (part.text.trim().length > 0) {
      hasMeaningfulPart = true;
      continue;
    }
    const previous = index > 0 ? value.parts[index - 1] : undefined;
    if (!previous || previous.t === 'text') {
      context.addIssue({
        code: 'custom',
        path: ['parts', index],
        message: 'Discussion content must not contain adjacent or leading empty text parts',
      });
    }
  }
  if (!hasMeaningfulPart) {
    context.addIssue({
      code: 'custom',
      path: ['parts'],
      message: 'Discussion content must contain at least one mention or non-blank text run',
    });
  }
})));
export type SessionDiscussionMessageContentV1 = z.infer<typeof SessionDiscussionMessageContentV1Schema>;
export const SessionDiscussionMessageContentV1StoredSchema = createStoredReadSchema(SessionDiscussionMessageContentV1Schema);

/**
 * The one bounded, immutable, display-only provenance shape consumed by both
 * interactive-run launch and Send selected to Session. It carries no plaintext,
 * no access authority, and no instruction to fetch discussion context.
 */
export const SessionDiscussionSelectionSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session_discussion'),
  sessionId: SessionDiscussionIdSchema,
  discussionId: SessionDiscussionIdSchema,
  messageIds: z.array(SessionDiscussionMessageIdSchema).check(z.minLength(1), z.refine((value) => new Set(value).size === value.length, 'Selected discussion message ids must be deduplicated')),
  draftCorrelationId: z.optional(SessionDiscussionIdSchema),
}));
export type SessionDiscussionSelectionSourceV1 = z.infer<typeof SessionDiscussionSelectionSourceV1Schema>;

/**
 * Mandatory host-stamped attribution for a discussion message an Agent posted
 * on behalf of its authenticated execution Account. It is descriptive display
 * metadata: the authenticated principal, never this field, is authority.
 */
export const SessionDiscussionProducerV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('agent'),
  sessionId: SessionDiscussionIdSchema,
  runId: z.optional(SessionDiscussionIdSchema),
  toolCallId: z.optional(SessionDiscussionIdSchema),
}));
export type SessionDiscussionProducerV1 = z.infer<typeof SessionDiscussionProducerV1Schema>;
