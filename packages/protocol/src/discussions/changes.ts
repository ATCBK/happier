import { z } from 'zod/mini';

/**
 * The advisory AccountChange hint for discussion writes.
 *
 * `AccountChange` rows are uniquely keyed and coalesced. This carries no ids,
 * content, titles, cursors, or an allegedly complete discussion list: a client
 * that sees a `discussion` change for a mounted discussion
 * surface must still reread canonical state. The hint may only skip work when
 * it is present.
 */
export const DiscussionChangeHintV1Schema = z.strictObject({
  v: z.literal(1),
  discussions: z.literal(true),
});
export type DiscussionChangeHintV1 = z.infer<typeof DiscussionChangeHintV1Schema>;

export const DISCUSSION_CHANGE_HINT_V1: DiscussionChangeHintV1 = Object.freeze({
  v: 1,
  discussions: true,
});

export function readDiscussionChangeHintV1(value: unknown): DiscussionChangeHintV1 | null {
  const parsed = DiscussionChangeHintV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

