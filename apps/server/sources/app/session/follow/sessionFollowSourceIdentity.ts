import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

type SessionFollowSourceIdentityV1 = Extract<FollowSourceRefV1, { kind: 'session' | 'discussion' }>;

/** Durable edge identity; equal raw ids from different source domains stay distinct. */
export function sourceKeyForSessionFollowSourceV1(source: SessionFollowSourceIdentityV1): string {
    return source.kind === 'session' ? `session:${source.sessionId}` : `discussion:${source.discussionId}`;
}

/** Narrow database projections before passing them to Session-only graph owners. */
export function hasSessionFollowSessionSource<T extends { sourceSessionId: string | null }>(row: T): row is T & { sourceSessionId: string } {
    return row.sourceSessionId !== null;
}
