import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { DiscussionIdSchema, DiscussionLocalIdSchema } from './content.js';

const PageLimitSchema = lazyZodSchema(() => z.coerce.number().check(z.int(), z.minimum(1), z.maximum(100)));

/**
 * Discussion pages reuse the Session listing/transcript query-budget
 * convention: a bounded default page with a bounded caller override. The bound
 * belongs to the query owner, not to a count restriction on human messages.
 */
export const DISCUSSION_DEFAULT_PAGE_SIZE_V1 = 30;
export const DISCUSSION_MAX_PAGE_SIZE_V1 = 100;

export const DiscussionListQueryV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.optional(z.enum(['active', 'archived'])),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  limit: z.optional(PageLimitSchema),
  anchorSessionId: z.optional(DiscussionIdSchema),
  /** Preparation for one Doc in the authenticated Home; never an archived count. */
  anchorDocArtifactId: z.optional(DiscussionIdSchema),
  /** Reconciliation is always bound to the authenticated original creator. */
  creationLocalId: z.optional(DiscussionLocalIdSchema),
}).check(z.refine(value => value.anchorDocArtifactId === undefined || value.state !== 'archived',
  'Doc preparation lists active Discussions only')));
export type DiscussionListQueryV1 = z.infer<typeof DiscussionListQueryV1Schema>;

export const DiscussionMessagesQueryV1Schema = lazyZodSchema(() => z.strictObject({
  beforeSeq: z.optional(z.coerce.number().check(z.int(), z.minimum(1))),
  afterSeq: z.optional(z.coerce.number().check(z.int(), z.minimum(0))),
  limit: z.optional(PageLimitSchema),
  throughSeq: z.optional(z.coerce.number().check(z.int(), z.minimum(0))),
}).check(z.superRefine((value, context) => {
  if (value.beforeSeq !== undefined && value.afterSeq !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['afterSeq'],
      message: 'beforeSeq and afterSeq are mutually exclusive',
    });
  }
})));
export type DiscussionMessagesQueryV1 = z.infer<typeof DiscussionMessagesQueryV1Schema>;

