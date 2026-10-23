import {
    QUIET_SESSION_PERSONAL_ATTENTION_V1,
    resolveSessionPersonalAttentionV1,
    addSessionPersonalAttentionReasonV1,
    isPendingRequestAnswerableV1,
    resolvePendingRequestAttentionReasonV1,
    SessionPersonalAttentionReasonV1Schema,
    type SessionPersonalAttentionProjectionV1,
} from '@happier-dev/protocol/sessions/personal/attention';
import { resolvePersonalFollowOnceAttentionV1, type PersonalFollowOnceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveFollowDeliveryV1, type FollowEventV1, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { resolveSessionPersonalFollowEventV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { Message } from "@happier-dev/session-core/messages";
import {
    projectUiSessionRuntimeAwareness,
    readSessionRuntimePresentationFreshnessExpirations,
} from '../attention/runtimePresentation';
import { deriveLatestPendingRequestObservedAtFromSession, derivePendingRequestFlagsFromSession, listPendingSessionRequests } from '../pending/listPendingSessionRequests';
import { resolveLastViewedSessionSeq } from '../readCursor/resolveLastViewedSessionSeq';
import { resolveSessionListReadableSeq } from '../listing/sessionListRenderable';
import { readSessionOwnerMetadataView } from '../readSessionOwnerMetadataView';
import { readExternalSessionLink } from '../external/readExternalSessionLink';
import { deriveExternalSessionAttentionHasUnread } from '../external/readExternalSessionAttention';
import { isSessionPersonallyTrackedForViewer } from './sessionViewer';
import type { SessionListRenderableSession } from '../listing/sessionListRenderable';

/** Only consumed admission/attention facts invalidate Activity and Inbox projections. */
export function readSessionViewerAttentionSignature(session: Session | SessionListRenderableSession): string {
    const viewer = session.viewer;
    return [
        session.archivedAt ?? '',
        isSessionPersonallyTrackedForViewer(session) ? 1 : 0,
        viewer?.attention.needsAttention ? 1 : 0,
        viewer?.attention.primary ?? '',
        viewer?.attention.presentation ?? '',
        viewer?.attention.reasons.join(',') ?? '',
        viewer?.latestFailureSeq ?? '',
        viewer?.follow.onceDelivery?.event ?? '',
        viewer?.follow.onceDelivery?.requestId ?? '',
        viewer?.follow.onceDelivery?.turnId ?? '',
        viewer?.follow.onceDelivery?.agentStateVersion ?? '',
        session.latestTurnId ?? '',
        session.latestTurnStatus ?? '',
    ].join('|');
}

/** Exact accepted occurrence currently represented by the source, never ongoing tracking. */
export function readCurrentPersonalFollowOnceOccurrenceForViewer(
    session: Session,
    messages?: readonly Message[],
): PersonalFollowOnceOccurrenceV1 | null {
    const delivery = session.viewer?.follow.onceDelivery;
    if (!delivery || session.archivedAt != null) return null;
    if (delivery.event === 'permission_required' || delivery.event === 'user_action_required') {
        const responsible = session.viewer?.relevance.reasons.includes('responsible_for_me') === true;
        const capabilities = {
            canSubmitAgentInput: session.access?.capabilities.submitAgentInput === true || responsible,
            canApprovePermissions: session.access?.capabilities.approveRuntimePermissions === true || responsible,
        };
        const ids = listPendingSessionRequests(session, messages)
            .filter(request => isPendingRequestAnswerableV1(request, capabilities)
                && resolvePendingRequestAttentionReasonV1(request) === delivery.event)
            .map(request => request.id);
        return resolvePersonalFollowOnceAttentionV1({ delivery, currentRequestIds: ids }) ? delivery : null;
    }
    const expectedStatus = delivery.event === 'ready' ? 'completed' : delivery.event;
    return delivery.turnId === session.latestTurnId && session.latestTurnStatus === expectedStatus ? delivery : null;
}

const NO_ATTENTION_EXPIRATIONS: readonly number[] = [];

/**
 * The one legacy runtime input. Attention and its clock boundaries are read from
 * the same object so a consumer can never wake on a boundary the decision does
 * not actually use.
 */
function buildPreViewerRuntimeInput(
    session: Session,
    nowMs: number,
    messages?: readonly Message[],
) {
    const pending = derivePendingRequestFlagsFromSession(session, messages);
    return {
        ...session,
        hasPendingPermissionRequests: pending.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pending.hasPendingUserActionRequests,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session, messages),
        nowMs,
    };
}

/**
 * When this Session's personal attention would change by the clock alone.
 *
 * Only pre-viewer Homes have such an instant: their pending-request attention is
 * gated on a freshness budget that elapses while nothing arrives, so a mounted
 * surface that never re-projects keeps showing retired attention. A modern
 * viewer row is server-owned and expires nowhere on the client. Both legacy
 * permission and user-action freshness use the existing runtime owner budget.
 */
export function readSessionPersonalAttentionExpirationsForViewer(
    session: Session,
    nowMs: number,
    messages?: readonly Message[],
): readonly number[] {
    if (session.archivedAt != null) return NO_ATTENTION_EXPIRATIONS;
    if (session.viewer !== undefined) return NO_ATTENTION_EXPIRATIONS;
    if (!isSessionPersonallyTrackedForViewer(session)) return NO_ATTENTION_EXPIRATIONS;
    return readSessionRuntimePresentationFreshnessExpirations(
        buildPreViewerRuntimeInput(session, nowMs, messages),
        nowMs,
    );
}

function addRuleAttentionForViewer(session: Session, existing: SessionPersonalAttentionProjectionV1,
    nowMs: number, messages: readonly Message[] | undefined, policies: readonly FollowPolicyV1[]): SessionPersonalAttentionProjectionV1 {
    const viewer = session.viewer;
    if (!viewer || policies.length === 0) return existing;
    const metadata = readSessionOwnerMetadataView(session);
    const runtime = projectUiSessionRuntimeAwareness(buildPreViewerRuntimeInput(session, nowMs, messages));
    const pending = derivePendingRequestFlagsFromSession(session, messages);
    const projected = resolveSessionPersonalAttentionV1({
        tracked: true, accessible: session.access?.capabilities.readTranscript === true, accountSuspended: false,
        contentAvailable: session.metadataLayoutVersion !== 1 || metadata != null,
        visibleSessionSeq: resolveSessionListReadableSeq(session, undefined), readState: viewer.readState,
        latestReadyEventSeq: session.latestReadyEventSeq ?? null,
        latestFailureSeq: viewer.latestFailureSeq ?? null,
        hasPrimarySessionFailure: runtime.operational.reasons.includes('failed'),
        pendingBlockedCount: session.pendingBlockedCount ?? 0,
        pendingPermissionRequestCount: pending.hasPendingPermissionRequests ? 1 : 0,
        pendingUserActionRequestCount: pending.hasPendingUserActionRequests ? 1 : 0,
        capabilities: { canSubmitAgentInput: session.access?.capabilities.submitAgentInput === true,
            canApprovePermissions: session.access?.capabilities.approveRuntimePermissions === true },
        responsible: viewer.relevance.reasons.includes('responsible_for_me'),
        discussion: { hasUnread: false, hasMention: false }, attentionStanding: 'none', reminderDue: false,
    });
    const selected = new Set(projected.reasons.filter(reason => {
        let event: FollowEventV1 | null = null;
        if (reason === 'failed' || reason === 'permission_required' || reason === 'user_action_required') event = resolveSessionPersonalFollowEventV1(reason);
        else if (reason === 'pending_blocked') event = { kind: 'needs_you', type: 'blocked' };
        else if (reason === 'ready_after_read') event = resolveSessionPersonalFollowEventV1('ready');
        else if (reason === 'unread') {
            const readyAfterRead = viewer.readState.state === 'tracking' && (session.latestReadyEventSeq ?? 0) > viewer.readState.lastViewedSessionSeq;
            event = resolveSessionPersonalFollowEventV1(readyAfterRead ? 'ready' : 'message');
        }
        return event !== null && resolveFollowDeliveryV1({ policies, event }).person.inbox;
    }));
    const reasons = SessionPersonalAttentionReasonV1Schema.options.filter(reason => selected.has(reason)
        || existing.needsAttention && existing.reasons.includes(reason));
    return { needsAttention: reasons.length > 0, reasons, primary: reasons[0] ?? null,
        presentation: existing.needsAttention ? existing.presentation : projected.presentation };
}

/** Modern viewer facts plus transient private rule interest; no persisted viewer mutation. */
export function resolveSessionPersonalAttentionForViewer(
    session: Session,
    nowMs: number,
    messages?: readonly Message[],
    rulePolicies: readonly FollowPolicyV1[] = [],
): SessionPersonalAttentionProjectionV1 {
    if (session.archivedAt != null) {
        return QUIET_SESSION_PERSONAL_ATTENTION_V1;
    }
    // A modern server projection already applied owner-or-Follow tracking and
    // owns the sole due-reminder exception. Do not suppress that exception by
    // re-running the older tracking guard in a consumer.
    if (session.viewer !== undefined) {
        const delivery = session.viewer.follow.onceDelivery;
        const current = delivery?.event === 'permission_required' || delivery?.event === 'user_action_required'
            ? readCurrentPersonalFollowOnceOccurrenceForViewer(session, messages) : null;
        const existing = current ? addSessionPersonalAttentionReasonV1(session.viewer.attention, current.event === 'permission_required'
            ? 'permission_required' : 'user_action_required') : session.viewer.attention;
        return addRuleAttentionForViewer(session, existing, nowMs, messages, rulePolicies);
    }
    if (!isSessionPersonallyTrackedForViewer(session)) {
        return QUIET_SESSION_PERSONAL_ATTENTION_V1;
    }

    // 0.2.11 owner compatibility: legacy scalar/metadata is read only, never
    // authoritative over a modern viewer row. Remove with pre-viewer Home support.
    const metadata = readSessionOwnerMetadataView(session);
    const runtime = projectUiSessionRuntimeAwareness(
        buildPreViewerRuntimeInput(session, nowMs, messages),
    );
    const externalUnread = readExternalSessionLink(metadata)
        ? deriveExternalSessionAttentionHasUnread(metadata) : null;
    const legacyCursor = resolveLastViewedSessionSeq(session);
    return resolveSessionPersonalAttentionV1({
        tracked: true,
        accessible: true,
        accountSuspended: false,
        contentAvailable: session.metadataLayoutVersion !== 1 || metadata != null,
        visibleSessionSeq: resolveSessionListReadableSeq(session, undefined),
        ...(externalUnread === null ? {} : { externalSessionHasUnread: externalUnread }),
        readState: legacyCursor === undefined
            ? { state: 'not_started' }
            : { state: 'tracking', lastViewedSessionSeq: legacyCursor, unreadSince: null },
        latestReadyEventSeq: session.latestReadyEventSeq ?? null,
        latestFailureSeq: null,
        hasPrimarySessionFailure: runtime.operational.reasons.includes('failed'),
        pendingBlockedCount: session.pendingBlockedCount ?? 0,
        pendingPermissionRequestCount: runtime.freshPermissionRequired ? 1 : 0,
        pendingUserActionRequestCount: runtime.freshActionRequired ? 1 : 0,
        capabilities: { canSubmitAgentInput: true, canApprovePermissions: true },
        responsible: false,
        discussion: { hasUnread: false, hasMention: false },
        attentionStanding: 'none',
        reminderDue: false,
    });
}
