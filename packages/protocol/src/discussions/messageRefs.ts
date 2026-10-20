import { DiscussionAddressV1Schema, DiscussionMessageRefV1Schema, CoordinationMessageRefV1Schema,
  type DiscussionAddressV1, type DiscussionMessageRefV1, type CoordinationMessageRefV1 } from './references.js';
export { DiscussionMessageRefV1Schema, CoordinationMessageRefV1Schema } from './references.js';
export type { DiscussionMessageRefV1, CoordinationMessageRefV1 } from './references.js';
import { DiscussionMessageV1Schema, type DiscussionMessageV1 } from './models.js';

/**
 * Called after a committed create/post acknowledgement or an authorized read.
 * The server cannot mint serverId: it is the saved client Home connection id.
 * Pending/local retry identities never enter this producer.
 */
export function createDiscussionMessageRefV1(
  address: DiscussionAddressV1,
  committedMessage: DiscussionMessageV1,
): DiscussionMessageRefV1 {
  const discussion = DiscussionAddressV1Schema.parse(address);
  const message = DiscussionMessageV1Schema.parse(committedMessage);
  if (message.discussionId !== discussion.discussionId) {
    throw new Error('Committed message does not belong to the captured Discussion');
  }
  return DiscussionMessageRefV1Schema.parse({ kind: 'discussion', discussion, messageId: message.id });
}

export function parseDiscussionMessageRefV1(value: unknown): DiscussionMessageRefV1 | null {
  const parsed = DiscussionMessageRefV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function areDiscussionMessageRefsEqualV1(left: DiscussionMessageRefV1, right: DiscussionMessageRefV1): boolean {
  return left.discussion.serverId === right.discussion.serverId
    && left.discussion.discussionId === right.discussion.discussionId
    && left.messageId === right.messageId;
}

export function parseCoordinationMessageRefV1(value: unknown): CoordinationMessageRefV1 | null {
  const parsed = CoordinationMessageRefV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function areCoordinationMessageRefsEqualV1(left: CoordinationMessageRefV1, right: CoordinationMessageRefV1): boolean {
  if (left.kind === 'discussion') return right.kind === 'discussion' && areDiscussionMessageRefsEqualV1(left, right);
  return right.kind === 'session' && left.session.serverId === right.session.serverId
    && left.session.sessionId === right.session.sessionId && left.messageId === right.messageId;
}
