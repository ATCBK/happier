import type { Session } from '@/sync/domains/state/storageTypes';

import type { ActivityOverviewSnapshot } from '../attention/activityAttentionTypes';
import { buildActivityOverviewSnapshot } from '../attention/buildActivityOverviewSnapshot';

export type ActivityBadgeState = Readonly<{
    count: number;
    showNonNumericDot: boolean;
}>;

export type ActivityBadgeSessionOptions = Readonly<{
    showUnread?: boolean;
    showPendingPermissionRequests?: boolean;
    showPendingUserActionRequests?: boolean;
    showQueuedUserInput?: boolean;
}>;

export function buildActivityBadgeState(params: Readonly<{
    sessions: ReadonlyArray<Session>;
    numericInboxCount: number;
    hasNonNumericInboxAttention: boolean;
    sessionOptions?: ActivityBadgeSessionOptions;
}>): ActivityBadgeState {
    const snapshot = buildActivityOverviewSnapshot({
        sessions: params.sessions,
        sessionOptions: params.sessionOptions,
    });

    return buildActivityBadgeStateFromOverview({
        overview: snapshot,
        numericInboxCount: params.numericInboxCount,
        hasNonNumericInboxAttention: params.hasNonNumericInboxAttention,
        sessionOptions: params.sessionOptions,
    });
}

export function buildActivityBadgeStateFromOverview(params: Readonly<{
    overview: ActivityOverviewSnapshot;
    numericInboxCount: number;
    hasNonNumericInboxAttention: boolean;
    sessionOptions?: ActivityBadgeSessionOptions;
}>): ActivityBadgeState {
    // The overview builder has already applied the presentation toggles while
    // preserving every other canonical attention reason. Reinterpreting the
    // reason booleans here made a mixed failure+unread candidate disappear when
    // unread presentation was disabled, creating a second badge authority.
    return buildActivityBadgeStateFromAttentionCount({
        attentionCount: params.overview.counts.totalAttention,
        numericInboxCount: params.numericInboxCount,
        hasNonNumericInboxAttention: params.hasNonNumericInboxAttention,
    });
}

/** Both detail and summary callers supply the attention owner's count; badge arithmetic stays here. */
export function buildActivityBadgeStateFromAttentionCount(params: Readonly<{
    attentionCount: number;
    numericInboxCount: number;
    hasNonNumericInboxAttention: boolean;
}>): ActivityBadgeState {
    const count = Math.max(0, params.attentionCount + Math.max(0, Math.trunc(params.numericInboxCount)));
    return {
        count,
        showNonNumericDot: count === 0 && params.hasNonNumericInboxAttention,
    };
}
