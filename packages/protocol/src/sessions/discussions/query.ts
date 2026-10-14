import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

const PageLimitSchema = lazyZodSchema(() => z.coerce.number().check(z.int(), z.minimum(1), z.maximum(100)));

/**
 * Discussion pages reuse the Session listing/transcript query-budget
 * convention: a bounded default page with a bounded caller override. The bound
 * belongs to the query owner, not to a count restriction on human messages.
 */
export const SESSION_DISCUSSION_DEFAULT_PAGE_SIZE_V1 = 30;
export const SESSION_DISCUSSION_MAX_PAGE_SIZE_V1 = 100;

export const SessionDiscussionListQueryV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.optional(z.enum(['active', 'archived'])),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  limit: z.optional(PageLimitSchema),
}));
export type SessionDiscussionListQueryV1 = z.infer<typeof SessionDiscussionListQueryV1Schema>;

export const SessionDiscussionMessagesQueryV1Schema = lazyZodSchema(() => z.strictObject({
  beforeSeq: z.optional(z.coerce.number().check(z.int(), z.minimum(1))),
  afterSeq: z.optional(z.coerce.number().check(z.int(), z.minimum(0))),
  limit: z.optional(PageLimitSchema),
}).check(z.superRefine((value, context) => {
  if (value.beforeSeq !== undefined && value.afterSeq !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['afterSeq'],
      message: 'beforeSeq and afterSeq are mutually exclusive',
    });
  }
})));
export type SessionDiscussionMessagesQueryV1 = z.infer<typeof SessionDiscussionMessagesQueryV1Schema>;
