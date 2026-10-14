import { z } from 'zod/mini';

/**
 * Follow configuration reuses the existing `account` AccountChange kind. A new
 * kind would make current planners treat the entry as unsupported and block
 * safe cursor advancement, and a per-follower Follow change would duplicate the
 * source Session's canonical invalidation.
 */
export const ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID = 'session-follows';

/**
 * A Session-scoped Follow change. The V1 consumer reloads the complete exact-Home
 * Follow snapshot, so this hint is truthfully coarse rather than carrying a
 * Session-id list no reader narrows by. A targeted hint belongs here only with a
 * measured consumer landed in the same change.
 */
export const SessionFollowChangeHintV1Schema = z.strictObject({
    sessionFollows: z.literal(true),
    full: z.literal(true),
  });
export type SessionFollowChangeHintV1 = z.infer<typeof SessionFollowChangeHintV1Schema>;

export function buildSessionFollowChangeHintV1(): SessionFollowChangeHintV1 {
  return { sessionFollows: true, full: true };
}

/**
 * Reads a Follow invalidation out of an Account change entry. Callers use it to
 * refresh the complete exact-Home Follow projection; an unrecognized hint
 * shape is not a Follow change.
 */
export function readSessionFollowChangeHintV1(value: unknown): SessionFollowChangeHintV1 | null {
  const parsed = SessionFollowChangeHintV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
