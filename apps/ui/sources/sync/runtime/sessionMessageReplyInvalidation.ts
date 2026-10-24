import type { SessionMessageReplyPendingHintV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionMessageReplyKey } from '@/sync/api/session/sessionMessageReplyApi';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

const listeners = new Map<string, Map<string, Set<() => void>>>();
function scopeKey(scope: ServerAccountScope) {
    return JSON.stringify([resolveServerProfileScopeIdForIdentifier(scope.serverId), scope.accountId]);
}
function requestKey(request: SessionMessageReplyKey) { return JSON.stringify([request.sessionId, request.localId]); }

/** No retained facts: original custody and the returned transcript remain the only state. */
export function subscribeSessionMessageReplyInvalidation(scope: ServerAccountScope, requests: readonly SessionMessageReplyKey[], listener: () => void) {
    const scopedId = scopeKey(scope);
    const scoped = listeners.get(scopedId) ?? new Map<string, Set<() => void>>();
    const keys = new Set(requests.map(requestKey));
    for (const id of keys) {
        const set = scoped.get(id) ?? new Set();
        set.add(listener); scoped.set(id, set);
    }
    if (keys.size) listeners.set(scopedId, scoped);
    return () => {
        for (const id of keys) {
            const set = scoped.get(id); set?.delete(listener);
            if (set?.size === 0) scoped.delete(id);
        }
        if (!scoped.size) listeners.delete(scopedId);
    };
}

export function publishSessionMessageReplyInvalidation(scope: ServerAccountScope, hint: SessionMessageReplyPendingHintV1): void {
    for (const listener of listeners.get(scopeKey(scope))?.get(requestKey({ sessionId: hint.sessionId, localId: hint.requestLocalId })) ?? []) listener();
}

/** Reconnect reconciles only live demand; closed rows retain no subscription. */
export function publishSessionMessageRepliesReconnected(scope: ServerAccountScope): void {
    const affected = new Set([...(listeners.get(scopeKey(scope))?.values() ?? [])].flatMap(set => [...set]));
    for (const listener of affected) listener();
}
