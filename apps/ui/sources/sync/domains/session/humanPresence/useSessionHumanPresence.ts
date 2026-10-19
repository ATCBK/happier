import * as React from 'react';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { SessionAddress } from '../sessionAddress';
import { sessionHumanPresenceStore, type DiscussionHumanPresenceTarget, type SessionHumanPresenceTarget, type SessionHumanPresenceView } from './sessionHumanPresenceStore';

const unavailablePresence: SessionHumanPresenceView = Object.freeze({
    status: 'unavailable', viewers: Object.freeze([]), observedAt: null,
});

function useHumanPresence(input: SessionHumanPresenceTarget | null, lifetime?: ServerAccountScopeLifetime | null): SessionHumanPresenceView {
    const serverIdentifier = input?.serverId ?? '';
    const sessionId = input?.sessionId ?? '';
    const discussionId = input?.discussionId;
    const hasTarget = input !== null && lifetime !== null;
    const serverId = resolveServerProfileScopeIdForIdentifier(serverIdentifier) || serverIdentifier;
    const target = React.useMemo<SessionHumanPresenceTarget | null>(() => hasTarget
        ? discussionId === undefined ? { serverId, sessionId } : { serverId, discussionId }
        : null, [discussionId, hasTarget, serverId, sessionId]);
    const subscribe = React.useCallback((listener: () => void) => {
        if (!target) return () => {};
        const off = sessionHumanPresenceStore.subscribe(target, listener);
        const retirement = lifetime?.onRetire(listener);
        return () => { off(); retirement?.dispose(); };
    }, [lifetime, target]);
    const read = React.useCallback(() => {
        if (!target || lifetime && (!lifetime.isCurrent()
            || resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId) !== serverId)) return unavailablePresence;
        return sessionHumanPresenceStore.read(target, lifetime?.scope.accountId);
    }, [lifetime, serverId, target]);
    return React.useSyncExternalStore(subscribe, read, read);
}

export function useSessionHumanPresence(input: SessionAddress | null): SessionHumanPresenceView {
    return useHumanPresence(input);
}

/** A Discussion observation belongs to the exact Home/Account binding that opened its resource. */
export function useDiscussionHumanPresence(input: DiscussionHumanPresenceTarget | null, lifetime: ServerAccountScopeLifetime | null): SessionHumanPresenceView {
    return useHumanPresence(input, lifetime);
}
