import type {
    SessionAwarenessProjectionV1,
    SessionPersonalAttentionProjectionV1,
} from '@happier-dev/protocol';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionAttentionOptions } from '@/sync/domains/session/attention/sessionAttention';
import type { SessionAwarenessPresentationStateV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionContextPresentation } from '@/sync/domains/session/presentation/sessionContextPresentation';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

export type SessionActivityAttention = Readonly<{
    session: Session;
    awareness: SessionAwarenessProjectionV1;
    sessionId: string;
    address?: SessionAddress | null;
    context?: SessionContextPresentation | null;
    serverId?: string | null;
    serverUrl?: string | null;
    serverName?: string | null;
    route?: string;
    target?: string;
    activityName?: string | null;
    activityInstanceKey?: string | null;
    serverFacts?: Readonly<{
        isKnown: boolean;
        isSaved: boolean;
        isActiveLocal: boolean;
    }>;
    directActionCapability?: Readonly<{
        canExecute: boolean;
        reason: 'allowed' | 'missing_target' | 'server_not_saved' | 'server_not_active' | 'disabled';
    }>;
    surfaceTiming?: ActivitySurfaceTimingBySurface;
    title: string;
    subtitle: string;
    attentionState: SessionAwarenessPresentationStateV1;
    workStatus: WorkStatusPresentation;
    /** Canonical viewer-facing reasons; downstream surfaces classify, never re-derive them. */
    personalAttention: SessionPersonalAttentionProjectionV1;
    /** Private rule matches admitted by the existing source evaluator, never viewer mutations. */
    followRulePolicies?: readonly FollowPolicyV1[];
    hasAttention: boolean;
    priority: number;
    lastTurnCompletedAt: number | null;
    reasons: Readonly<{
        hasUnread: boolean;
        hasPendingPermissionRequests: boolean;
        hasPendingUserActionRequests: boolean;
        hasBlockedPendingDelivery: boolean;
        hasQueuedUserInput: boolean;
        isThinking: boolean;
    }>;
}>;

export type ActivitySurfaceTimingFacts = Readonly<{
    staleAfterMs: number;
    dwellMs: number;
}>;

export type ActivitySurfaceTimingBySurface = Readonly<{
    desktopOverlay: ActivitySurfaceTimingFacts;
    liveActivity: ActivitySurfaceTimingFacts;
    homeWidget: ActivitySurfaceTimingFacts;
}>;

export type ActivityOverviewCounts = Readonly<{
    unread: number;
    permissionRequired: number;
    actionRequired: number;
    thinking: number;
    totalAttention: number;
}>;

export type ActivityOverviewSnapshot = Readonly<{
    counts: ActivityOverviewCounts;
    candidates: readonly SessionActivityAttention[];
    fingerprint?: string;
}>;

export type BuildActivityOverviewSnapshotParams = Readonly<{
    sessions: readonly Session[];
    sessionOptions?: SessionAttentionOptions;
    nowMs?: number;
}>;
