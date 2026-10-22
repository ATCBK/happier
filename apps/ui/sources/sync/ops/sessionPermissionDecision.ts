/**
 * Canonical construction and dispatch of session permission decisions.
 *
 * Owns the wire shape shared by foreground session ops (`sessionAllow`/`sessionDeny`)
 * and the headless Android notification executor, so one owner defines how a
 * permission decision is sent. Headless-capable: no dependency on `sessions.ts`
 * or the sync orchestrator, only on the scoped RPC seam and local state helpers.
 */
import { storage } from '../domains/state/storage';
import { nowServerMs } from '../runtime/time';
import { getActiveServerId, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { sessionRpcWithServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

export interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    execPolicyAmendment?: {
        command: string[];
    };
    /**
     * Optional permission updates to apply inside the agent runtime (provider-specific).
     * This is used to accept provider-suggested permission changes (e.g. Claude Agent SDK `permission_suggestions`).
     */
    updatedPermissions?: unknown;
    /**
     * AskUserQuestion: structured answers keyed by question text.
     * When present, the agent can complete the tool call without requiring a follow-up user message.
     */
    answers?: Record<string, string>;
}

export const NOTIFICATION_PERMISSION_DENY_REASON = 'Denied from notification';

export function buildNotificationPermissionDecisionRequest(action: 'allow' | 'deny', requestId: string): SessionPermissionRequest {
    return action === 'allow'
        ? { id: requestId, approved: true, decision: 'approved' }
        : { id: requestId, approved: false, decision: 'denied', reason: NOTIFICATION_PERMISSION_DENY_REASON };
}

// Best-effort local UX recovery: deny/abort decisions should immediately return
// the session to non-thinking state even if lifecycle events arrive out of order
// or providers publish intermittent thinking=false.
export function applySessionThinkingDecisionRecovery(sessionId: string): void {
    const session = storage.getState().sessions[sessionId];
    storage.getState().clearSessionOptimisticThinking(sessionId);
    storage.getState().clearSessionThinkingGrace(sessionId);
    if (!session || session.thinking !== true) {
        return;
    }

    storage.getState().applySessions([
        {
            ...session,
            thinking: false,
            updatedAt: nowServerMs(),
        },
    ]);
}

/**
 * Send a notification permission decision to an explicit server/account scope,
 * preserving one-shot network mode, cancellation and issuance information, and
 * returning the raw application acknowledgement for the caller to interpret.
 */
export async function sessionPermissionDecisionWithServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    requestId: string;
    action: 'allow' | 'deny';
    networkMode?: 'background-task';
    signal?: AbortSignal;
    onIssued?: () => void;
}>): Promise<unknown> {
    const result = await sessionRpcWithServerAccountScope<unknown, SessionPermissionRequest>({
        scope: params.scope,
        sessionId: params.sessionId,
        method: 'permission',
        networkMode: params.networkMode,
        signal: params.signal,
        payload: buildNotificationPermissionDecisionRequest(params.action, params.requestId),
        onIssued: params.onIssued,
    });
    // Background execution must not mutate another scope's UI state, and local
    // UX recovery must never corrupt the authoritative acknowledgement above.
    if (params.action === 'deny' && params.scope.serverId === resolveServerProfileScopeIdForIdentifier(getActiveServerId())) {
        try {
            applySessionThinkingDecisionRecovery(params.sessionId);
        } catch {
            console.warn('[notifications] Permission deny local recovery unavailable');
        }
    }
    return result;
}
