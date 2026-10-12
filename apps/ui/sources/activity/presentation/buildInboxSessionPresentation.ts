import type { SessionPersonalAttentionReasonV1 } from '@happier-dev/protocol';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { Message } from "@happier-dev/session-core/messages";
import { comparePendingRequestsByAge } from '@happier-dev/session-core/pending';
import type {
    ActivityOverviewSnapshot,
    SessionActivityAttention,
} from '@/activity/attention/activityAttentionTypes';
import type { SessionBulkActionTarget } from '@/components/sessions/actions/sessionBulkActionTypes';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import {
    listPendingPermissionRequests,
    listPendingUserActionRequests,
    type PendingPermissionRequest,
} from '@/utils/sessions/sessionUtils';

export type InboxSessionAttentionEntry = Readonly<{
    candidate: SessionActivityAttention;
    pendingPermissions: readonly PendingPermissionRequest[];
    pendingUserActions: readonly PendingPermissionRequest[];
}>;

export type InboxSessionPresentation = Readonly<{
    sessionsNeedingAttention: readonly InboxSessionAttentionEntry[];
    readySessions: readonly SessionActivityAttention[];
    markAllReadTargets: readonly SessionBulkActionTarget[];
    pendingRequestHydrationTargets: readonly SessionAddress[];
}>;

export type InboxSessionCandidateClassification = 'needs_attention' | 'ready' | null;

/**
 * Classifies one canonical Activity candidate for Inbox without constructing
 * rows, pending-request details, or bulk-action targets.
 */
export function classifyInboxSessionCandidate(
    candidate: SessionActivityAttention,
): InboxSessionCandidateClassification {
    if (!candidate.hasAttention) return null;

    const reasons = candidate.personalAttention.reasons;
    const hasSessionReadAttention = reasons.some(isClearedBySessionManualRead);
    const hasOtherAttention = reasons.some((reason) => !isClearedBySessionManualRead(reason));
    const isWorking = candidate.awareness.operational.reasons.includes('working')
        || candidate.awareness.operational.reasons.includes('background_activity');
    const hasReadyForReviewAttention = !isWorking
        && hasSessionReadAttention
        && (
            candidate.attentionState === 'ready'
            || reasons.includes('ready_after_read')
            || candidate.awareness.operational.reasons.includes('ready')
        );

    if (hasOtherAttention) return 'needs_attention';
    return hasReadyForReviewAttention ? 'ready' : null;
}

/**
 * Which canonical Activity reasons a session-scoped manual read actually clears.
 *
 * Total over the Protocol union on purpose: a new reason is a compile error here
 * rather than silently joining one of the two sections. `unread_discussion` and
 * `mentioned` are Discussion-owned and survive a session read cursor, so Inbox
 * must never offer them to the session mark-read operation.
 */
function isClearedBySessionManualRead(reason: SessionPersonalAttentionReasonV1): boolean {
    switch (reason) {
        case 'unread':
        case 'ready_after_read':
            return true;
        case 'failed':
        case 'permission_required':
        case 'user_action_required':
        case 'pending_blocked':
        case 'mentioned':
        case 'unread_discussion':
        case 'reminder_due':
        case 'manual':
            return false;
    }
}

/**
 * Inbox is a presentation of the canonical Activity projection. It chooses a
 * section and builds action targets, but never decides whether attention exists.
 */
export function buildInboxSessionPresentation(params: Readonly<{
    overview: ActivityOverviewSnapshot;
    resolveMessages?: (candidate: SessionActivityAttention) => readonly Message[] | undefined;
}>): InboxSessionPresentation {
    const sessionsNeedingAttention: InboxSessionAttentionEntry[] = [];
    const readySessions: SessionActivityAttention[] = [];
    const markAllReadTargets: SessionBulkActionTarget[] = [];
    const pendingRequestHydrationTargets: SessionAddress[] = [];

    for (const candidate of params.overview.candidates) {
        const classification = classifyInboxSessionCandidate(candidate);
        if (classification === null) continue;

        const reasons = candidate.personalAttention.reasons;
        const serverId = candidate.address?.serverId ?? candidate.serverId ?? null;

        // The Inbox follows the Session list's attention lanes: streaming
        // transcript progress remains a server-owned unread fact, but it is not
        // Inbox work until the existing awareness projection says the turn is
        // ready for review. Concurrent actionable reasons still render below.
        if (classification === 'needs_attention') {
            // Notification privacy is not the in-app content-readability authority.
            const mayShowDetails = isSessionAwarenessContentReadableV1(candidate.awareness.encryption);
            // Missing exact-Home data must not fall back to the ambient same-id transcript.
            const messages = mayShowDetails ? params.resolveMessages?.(candidate) ?? [] : [];
            const entry: InboxSessionAttentionEntry = {
                candidate,
                pendingPermissions: mayShowDetails && reasons.includes('permission_required')
                    ? listPendingPermissionRequests(candidate.session, messages).sort(comparePendingRequestsByAge)
                    : [],
                pendingUserActions: mayShowDetails && reasons.includes('user_action_required')
                    ? listPendingUserActionRequests(candidate.session, messages).sort(comparePendingRequestsByAge)
                    : [],
            };
            sessionsNeedingAttention.push(entry);
            if (mayShowDetails && candidate.address && (
                (reasons.includes('permission_required') && entry.pendingPermissions.length === 0)
                || (reasons.includes('user_action_required') && entry.pendingUserActions.length === 0)
            )) pendingRequestHydrationTargets.push(candidate.address);
            continue;
        }

        if (classification === 'ready') {
            readySessions.push(candidate);
            markAllReadTargets.push({
                key: buildServerScopedSessionKey(candidate.sessionId, serverId),
                sessionId: candidate.sessionId,
                serverId,
                readState: 'unread',
            });
        }
    }

    return {
        sessionsNeedingAttention,
        readySessions,
        markAllReadTargets,
        pendingRequestHydrationTargets,
    };
}
