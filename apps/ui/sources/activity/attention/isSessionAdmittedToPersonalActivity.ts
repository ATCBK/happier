import type { Session } from '@/sync/domains/state/storageTypes';
import { isSessionPersonallyTrackedForViewer } from '@/sync/domains/session/readState/sessionViewer';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

/** Access-scoped sync supplies rows; retained archived rows never enter active surfaces. */
export function isSessionAdmittedToPersonalActivity(session: Session, rulePolicies: readonly FollowPolicyV1[] = []): boolean {
    if (session.archivedAt != null) return false;
    if (rulePolicies.length > 0) return true;
    if (session.viewer !== undefined) {
        // The strict Activity source already selected the canonical `my_work`
        // corpus. Relevance admits assignment, Follow, ownership, participation,
        // pin and explicit attention without turning an unfollowed row into
        // tracked unread. Bare Team/Group access has `relevant: false` and stays
        // out of personal surfaces.
        return session.viewer.relevance.relevant
            || session.viewer.attention.needsAttention;
    }
    return isSessionPersonallyTrackedForViewer(session);
}
