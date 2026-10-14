import { z } from 'zod/mini';

/**
 * The advisory AccountChange hint for discussion writes.
 *
 * `AccountChange` rows are uniquely keyed and coalesced, so a later Session
 * mutation can overwrite this hint entirely. It therefore carries no ids,
 * content, titles, cursors, or an allegedly complete discussion list: a client
 * that sees any `session` change for a Session with a mounted discussion
 * surface must still reread canonical state. The hint may only skip work when
 * it is present.
 */
export const SessionDiscussionChangeHintV1Schema = z.strictObject({
  v: z.literal(1),
  sessionDiscussions: z.literal(true),
});
export type SessionDiscussionChangeHintV1 = z.infer<typeof SessionDiscussionChangeHintV1Schema>;

export const SESSION_DISCUSSION_CHANGE_HINT_V1: SessionDiscussionChangeHintV1 = Object.freeze({
  v: 1,
  sessionDiscussions: true,
});

export function readSessionDiscussionChangeHintV1(value: unknown): SessionDiscussionChangeHintV1 | null {
  const parsed = SessionDiscussionChangeHintV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
