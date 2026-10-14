import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { SessionMessageAccountActorV1Schema } from '../messages/sessionMessageAccountActorV1.js';
import { refineDiscussionAccountActor } from './accountActorConsistency.js';

import {
  SESSION_DISCUSSION_MAX_PAGE_SIZE_V1,
  SessionDiscussionListQueryV1Schema,
} from './query.js';
import {
  SESSION_DISCUSSION_ACTION_IDS_V1,
  type SessionDiscussionActionIdV1,
} from './actionIds.js';
import {
  SessionDiscussionAccountIdSchema,
  SessionDiscussionIdSchema,
  SessionDiscussionLocalIdSchema,
  SessionDiscussionMessageContentV1Schema,
  SessionDiscussionMessageIdSchema,
  SessionDiscussionProducerV1Schema,
  SessionDiscussionTitleV1Schema,
} from './content.js';
import {
  SESSION_DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1,
  SessionDiscussionCapabilitiesV1Schema,
  SessionDiscussionLatestMessageV1Schema,
  SessionDiscussionReadCursorV1Schema,
} from './models.js';

/**
 * Optional only because the executor's existing contextual rule stamps the
 * current Session, exactly as the Board family does.
 */
const SessionDiscussionActionSessionIdSchema = lazyZodSchema(() => z.optional(SessionDiscussionIdSchema));

/**
 * A caller-chosen retry identity. It stays optional because most tool callers
 * have no durable identity to reuse; the executor mints one when it is absent.
 * It is never authority: the mutation owner binds it to its authenticated
 * author, so it can reconcile a lost response but can never adopt another
 * Account's result.
 */
const SessionDiscussionActionLocalIdSchema = lazyZodSchema(() => z.optional(SessionDiscussionLocalIdSchema));

const MentionedAccountIdsSchema = lazyZodSchema(() => z.array(SessionDiscussionAccountIdSchema).check(z.refine((value) => new Set(value).size === value.length, 'Mentioned Account ids must be deduplicated')));

const SequenceSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0)));

/**
 * The authored title as plaintext. Action inputs carry strict semantic
 * plaintext; the executor seals it through the existing Session cipher before
 * it reaches the storage route. A plaintext Action input is never registered as
 * the encrypted storage-route schema.
 */
const SessionDiscussionActionTitleSchema = SessionDiscussionTitleV1Schema.shape.title;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const SessionDiscussionListInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionDiscussionActionSessionIdSchema,
  state: SessionDiscussionListQueryV1Schema.shape.state,
  cursor: SessionDiscussionListQueryV1Schema.shape.cursor,
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(SESSION_DISCUSSION_MAX_PAGE_SIZE_V1))),
}));
export type SessionDiscussionListInputV1 = z.infer<typeof SessionDiscussionListInputV1Schema>;

export const SessionDiscussionGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionDiscussionActionSessionIdSchema,
  discussionId: SessionDiscussionIdSchema,
}));
export type SessionDiscussionGetInputV1 = z.infer<typeof SessionDiscussionGetInputV1Schema>;

export const SessionDiscussionReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionDiscussionActionSessionIdSchema,
  discussionId: SessionDiscussionIdSchema,
  beforeSeq: z.optional(z.number().check(z.int(), z.minimum(1))),
  afterSeq: z.optional(SequenceSchema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(SESSION_DISCUSSION_MAX_PAGE_SIZE_V1))),
}).check(z.superRefine((value, context) => {
  if (value.beforeSeq !== undefined && value.afterSeq !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['afterSeq'],
      message: 'beforeSeq and afterSeq are mutually exclusive',
    });
  }
})));
export type SessionDiscussionReadInputV1 = z.infer<typeof SessionDiscussionReadInputV1Schema>;

export const SessionDiscussionCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionDiscussionActionSessionIdSchema,
  creationLocalId: SessionDiscussionActionLocalIdSchema,
  title: SessionDiscussionActionTitleSchema,
  firstMessage: z.strictObject({
    localId: SessionDiscussionActionLocalIdSchema,
    content: SessionDiscussionMessageContentV1Schema,
    mentionedAccountIds: z.optional(MentionedAccountIdsSchema),
  }),
}));
export type SessionDiscussionCreateInputV1 = z.infer<typeof SessionDiscussionCreateInputV1Schema>;

export const SessionDiscussionPostInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionDiscussionActionSessionIdSchema,
  discussionId: SessionDiscussionIdSchema,
  localId: SessionDiscussionActionLocalIdSchema,
  content: SessionDiscussionMessageContentV1Schema,
  mentionedAccountIds: z.optional(MentionedAccountIdsSchema),
}));
export type SessionDiscussionPostInputV1 = z.infer<typeof SessionDiscussionPostInputV1Schema>;

export const SessionDiscussionRenameInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionDiscussionActionSessionIdSchema,
  discussionId: SessionDiscussionIdSchema,
  title: SessionDiscussionActionTitleSchema,
}));
export type SessionDiscussionRenameInputV1 = z.infer<typeof SessionDiscussionRenameInputV1Schema>;

export const SessionDiscussionLifecycleInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionDiscussionActionSessionIdSchema,
  discussionId: SessionDiscussionIdSchema,
}));
export type SessionDiscussionLifecycleInputV1 = z.infer<typeof SessionDiscussionLifecycleInputV1Schema>;

export const SessionDiscussionReadStateSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionDiscussionActionSessionIdSchema,
  discussionId: SessionDiscussionIdSchema,
  lastReadSeq: SequenceSchema,
}));
export type SessionDiscussionReadStateSetInputV1 = z.infer<typeof SessionDiscussionReadStateSetInputV1Schema>;

// ---------------------------------------------------------------------------
// Opened (decrypted) projections
// ---------------------------------------------------------------------------

/**
 * A summary whose title the executor opened through the Session cipher.
 *
 * `title` is nullable because missing or invalid E2EE material is a real state:
 * the executor reports the row and marks the page `incomplete` rather than
 * interpreting ciphertext as plaintext or silently dropping the discussion.
 */
export const SessionDiscussionOpenedSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  id: SessionDiscussionIdSchema,
  sessionId: SessionDiscussionIdSchema,
  creationLocalId: z.nullable(SessionDiscussionLocalIdSchema),
  title: z.nullable(z.string()),
  latestMessage: SessionDiscussionLatestMessageV1Schema,
  messageSeq: SequenceSchema,
  lastReadSeq: z.nullable(SequenceSchema),
  unreadCount: SequenceSchema,
  unreadMentionCount: SequenceSchema,
  recentAuthorAccountIds: z.array(SessionDiscussionAccountIdSchema).check(z.maxLength(SESSION_DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1)),
  archivedAt: z.nullable(z.number().check(z.int())),
  capabilities: SessionDiscussionCapabilitiesV1Schema,
}));
export type SessionDiscussionOpenedSummaryV1 = z.infer<typeof SessionDiscussionOpenedSummaryV1Schema>;

export const SessionDiscussionOpenedMessageV1Schema = lazyZodSchema(() => z.strictObject({
  id: SessionDiscussionMessageIdSchema,
  discussionId: SessionDiscussionIdSchema,
  localId: z.nullable(SessionDiscussionLocalIdSchema),
  seq: z.number().check(z.int(), z.minimum(1)),
  authorAccountId: z.nullable(SessionDiscussionAccountIdSchema),
  accountActor: z.nullable(SessionMessageAccountActorV1Schema),
  producerV1: z.nullable(SessionDiscussionProducerV1Schema),
  /** `null` when this viewer could not open the row; never a plaintext guess. */
  content: z.nullable(SessionDiscussionMessageContentV1Schema),
  mentionedAccountIds: z.array(SessionDiscussionAccountIdSchema),
  createdAt: z.number().check(z.int()),
}).check(z.superRefine(refineDiscussionAccountActor)));
export type SessionDiscussionOpenedMessageV1 = z.infer<typeof SessionDiscussionOpenedMessageV1Schema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const ResultEnvelopeShape = {
  v: z.literal(1),
  serverId: z.string().check(z.trim(), z.minLength(1)),
  sessionId: SessionDiscussionIdSchema,
} as const;

export const SessionDiscussionListResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  discussions: z.array(SessionDiscussionOpenedSummaryV1Schema),
  nextCursor: z.nullable(z.string()),
  /** At least one row on this page could not be opened for the caller. */
  incomplete: z.boolean(),
}));
export type SessionDiscussionListResultV1 = z.infer<typeof SessionDiscussionListResultV1Schema>;

export const SessionDiscussionDetailsResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  discussion: SessionDiscussionOpenedSummaryV1Schema,
}));
export type SessionDiscussionDetailsResultV1 = z.infer<typeof SessionDiscussionDetailsResultV1Schema>;

export const SessionDiscussionReadResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  discussionId: SessionDiscussionIdSchema,
  messages: z.array(SessionDiscussionOpenedMessageV1Schema),
  hasMoreOlder: z.boolean(),
  messageSeq: SequenceSchema,
  incomplete: z.boolean(),
}));
export type SessionDiscussionReadResultV1 = z.infer<typeof SessionDiscussionReadResultV1Schema>;

export const SessionDiscussionCreateResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  discussion: SessionDiscussionOpenedSummaryV1Schema,
  firstMessage: SessionDiscussionOpenedMessageV1Schema,
}));
export type SessionDiscussionCreateResultV1 = z.infer<typeof SessionDiscussionCreateResultV1Schema>;

export const SessionDiscussionPostResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  message: SessionDiscussionOpenedMessageV1Schema,
  messageSeq: z.number().check(z.int(), z.minimum(1)),
}));
export type SessionDiscussionPostResultV1 = z.infer<typeof SessionDiscussionPostResultV1Schema>;

export const SessionDiscussionReadStateResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  cursor: SessionDiscussionReadCursorV1Schema,
}));
export type SessionDiscussionReadStateResultV1 = z.infer<typeof SessionDiscussionReadStateResultV1Schema>;

export const SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1 = Object.freeze({
  'session.discussion.list': SessionDiscussionListInputV1Schema,
  'session.discussion.get': SessionDiscussionGetInputV1Schema,
  'session.discussion.read': SessionDiscussionReadInputV1Schema,
  'session.discussion.create': SessionDiscussionCreateInputV1Schema,
  'session.discussion.post': SessionDiscussionPostInputV1Schema,
  'session.discussion.rename': SessionDiscussionRenameInputV1Schema,
  'session.discussion.archive': SessionDiscussionLifecycleInputV1Schema,
  'session.discussion.restore': SessionDiscussionLifecycleInputV1Schema,
  'session.discussion.read_state.set': SessionDiscussionReadStateSetInputV1Schema,
} as const satisfies Readonly<Record<SessionDiscussionActionIdV1, z.ZodMiniType>>);

export const SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1 = Object.freeze({
  'session.discussion.list': SessionDiscussionListResultV1Schema,
  'session.discussion.get': SessionDiscussionDetailsResultV1Schema,
  'session.discussion.read': SessionDiscussionReadResultV1Schema,
  'session.discussion.create': SessionDiscussionCreateResultV1Schema,
  'session.discussion.post': SessionDiscussionPostResultV1Schema,
  'session.discussion.rename': SessionDiscussionDetailsResultV1Schema,
  'session.discussion.archive': SessionDiscussionDetailsResultV1Schema,
  'session.discussion.restore': SessionDiscussionDetailsResultV1Schema,
  'session.discussion.read_state.set': SessionDiscussionReadStateResultV1Schema,
} as const satisfies Readonly<Record<SessionDiscussionActionIdV1, z.ZodMiniType>>);

export type SessionDiscussionActionInputV1ById = Readonly<{
  [TActionId in SessionDiscussionActionIdV1]:
    z.infer<(typeof SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1)[TActionId]>;
}>;

export { SESSION_DISCUSSION_ACTION_IDS_V1 };
