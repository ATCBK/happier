import type { DiscussionAnchorV1 } from '@happier-dev/protocol/discussions';

/** The captured Home is independent of any optional Discussion source. */
export type DiscussionHomeAddress = Readonly<{ serverId: string }>;

export type DiscussionDetailsTarget =
    | Readonly<{ kind: 'new'; address: DiscussionHomeAddress; anchor?: DiscussionAnchorV1; draftId?: string }>
    | Readonly<{ kind: 'discussion'; address: DiscussionHomeAddress; discussionId: string; messageId?: string }>;
