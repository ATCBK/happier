import { resolvePersonalFollowOnceAttentionV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveSessionInboxAttentionV1, type SessionInboxAttentionClassificationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
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
import { isTranscriptPendingRequestAnswerable } from '@/utils/sessions/deriveTranscriptInteraction';
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

export type InboxSessionCandidateClassification = SessionInboxAttentionClassificationV1;

/**
 * Normalize the existing Activity owner facts for C1 without loading request details.
 */
export function classifyInboxSessionCandidate(
    candidate: SessionActivityAttention,
    questionType?: NonNullable<PendingPermissionRequest['questionV1']>['type'],
): InboxSessionCandidateClassification {
    const delivery = candidate.session.viewer?.follow.onceDelivery;
    return resolveSessionInboxAttentionV1({
        personalAttention: { ...candidate.personalAttention, needsAttention: candidate.hasAttention },
        hasBlockedPendingDelivery: candidate.reasons.hasBlockedPendingDelivery,
        questionType,
        working: candidate.awareness.operational.reasons.includes('working')
            || candidate.awareness.operational.reasons.includes('background_activity'),
        ready: candidate.attentionState === 'ready' || candidate.awareness.operational.reasons.includes('ready'),
        onceDelivery: delivery,
        onceAttentionReason: resolvePersonalFollowOnceAttentionV1({ delivery }),
    });
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
        if (classification.section === null) continue;

        const reasons = candidate.personalAttention.reasons;
        const serverId = candidate.address?.serverId ?? candidate.serverId ?? null;

        // The Inbox follows the Session list's attention lanes: streaming
        // transcript progress remains a server-owned unread fact, but it is not
        // Inbox work until the existing awareness projection says the turn is
        // ready for review. Concurrent actionable reasons still render below.
        if (classification.section === 'needs_attention') {
            // Notification privacy is not the in-app content-readability authority.
            const mayShowDetails = isSessionAwarenessContentReadableV1(candidate.awareness.encryption);
            // Missing exact-Home data must not fall back to the ambient same-id transcript.
            const messages = mayShowDetails ? params.resolveMessages?.(candidate) ?? [] : [];
            const entry: InboxSessionAttentionEntry = {
                candidate,
                pendingPermissions: mayShowDetails && reasons.includes('permission_required')
                    ? listPendingPermissionRequests(candidate.session, messages)
                        .filter(request => isTranscriptPendingRequestAnswerable(candidate.session, request)).sort(comparePendingRequestsByAge)
                    : [],
                pendingUserActions: mayShowDetails && reasons.includes('user_action_required')
                    ? listPendingUserActionRequests(candidate.session, messages)
                        .filter(request => isTranscriptPendingRequestAnswerable(candidate.session, request)).sort(comparePendingRequestsByAge)
                    : [],
            };
            sessionsNeedingAttention.push(entry);
            if (mayShowDetails && candidate.address && (
                (reasons.includes('permission_required') && entry.pendingPermissions.length === 0)
                || (reasons.includes('user_action_required') && entry.pendingUserActions.length === 0
                    && isTranscriptPendingRequestAnswerable(candidate.session, { kind: 'user_action' }))
            )) pendingRequestHydrationTargets.push(candidate.address);
            continue;
        }

        if (classification.section === 'ready') {
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
