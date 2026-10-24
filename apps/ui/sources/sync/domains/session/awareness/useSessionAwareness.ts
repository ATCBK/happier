import * as React from 'react';
import { useActiveServerAccountScope, useSession } from '@/sync/domains/state/storage';
import { useSessionListRelativeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import { nowServerMs } from '@/sync/runtime/time';
import { deriveLatestPendingRequestObservedAtFromSession, derivePendingRequestFlagsFromSession, listPendingSessionRequests } from '../pending/listPendingSessionRequests';
import { readSessionRuntimePresentationFreshnessExpirations } from '../attention/runtimePresentation';
import { projectUiSessionAwareness } from './sessionAwareness';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionAwarenessProjectionV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import { selectOldestPendingRequest, type SessionPendingRequest } from '@happier-dev/session-core/pending';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { buildPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';
import { isSessionContentReadable, readSessionContentAvailability } from '../encryptedContentAvailability';
import { useSessionContentDemand } from '../useSessionContentDemand';
import { getSessionSurfaceVisibilityResetVersion, subscribeSessionSurfaceVisibilityReset } from '../sessionSurfaceVisibility';

const NO_PENDING_REQUESTS: readonly SessionPendingRequest[] = Object.freeze([]);
export type SessionAwarenessScopeOptions = Readonly<{ accountLifetime: ServerAccountScopeLifetime | null; enabled?: boolean }>;

type AwarenessBinding<TSession extends Session | null, TAwareness extends SessionAwarenessProjectionV1 | null> = Readonly<{
    session: TSession;
    awareness: TAwareness;
    /** A scoped cold source is still being acquired, not yet known unavailable. */
    contentPending: boolean;
    turnStartedAtMs: number | null;
    pendingRequests: readonly SessionPendingRequest[];
    /** Existing pending-navigation landing consumes this exact id/source after opening requestHref. */
    oldestPendingRequest: SessionPendingRequest | null;
    requestHref: string | null;
}>;

/** When the turn in progress started; null while no turn runs. Every elapsed clock reads this one fact. */
export function readSessionTurnStartedAtMs(session: Pick<Session, 'latestTurnStatus' | 'latestTurnStatusObservedAt'>): number | null {
    return session.latestTurnStatus === 'in_progress'
        && typeof session.latestTurnStatusObservedAt === 'number'
        && Number.isFinite(session.latestTurnStatusObservedAt) ? session.latestTurnStatusObservedAt : null;
}

/** Incumbent app awareness subscription, shared without importing the transcript host. */
export function useSessionAwareness(sessionId: string, serverId: string | null, fallbackSession: Session): AwarenessBinding<Session, SessionAwarenessProjectionV1>;
export function useSessionAwareness(sessionId: string, serverId: string | null): AwarenessBinding<Session | null, SessionAwarenessProjectionV1 | null>;
export function useSessionAwareness(sessionId: string, serverId: string | null, fallbackSession: Session | undefined,
    options: SessionAwarenessScopeOptions): AwarenessBinding<Session | null, SessionAwarenessProjectionV1 | null>;
export function useSessionAwareness(sessionId: string, serverId: string | null, fallbackSession?: Session, options?: SessionAwarenessScopeOptions) {
    const accountLifetime = options?.accountLifetime;
    const scopeRequired = options !== undefined;
    const enabled = options?.enabled !== false;
    const activeScope = useActiveServerAccountScope(scopeRequired ? serverId : null);
    const subscribeScope = React.useCallback((notify: () => void) => {
        const subscription = accountLifetime?.onRetire(notify);
        return () => subscription?.dispose();
    }, [accountLifetime]);
    const readCurrentScope = React.useCallback(() => enabled && (!scopeRequired
        || (accountLifetime?.isCurrent() === true && areServerProfileIdentifiersEquivalent(accountLifetime.scope.serverId, serverId)
            && areServerAccountScopesEqual(accountLifetime.scope, activeScope))),
    [accountLifetime, activeScope, enabled, scopeRequired, serverId]);
    const currentScope = React.useSyncExternalStore(subscribeScope, readCurrentScope, readCurrentScope);
    const resetVersion = React.useSyncExternalStore(subscribeSessionSurfaceVisibilityReset,
        getSessionSurfaceVisibilityResetVersion, getSessionSurfaceVisibilityResetVersion);
    const acquisition = React.useMemo(() => ({ sessionId, serverId, accountLifetime, currentScope, resetVersion }),
        [sessionId, serverId, accountLifetime, currentScope, resetVersion]);
    const [settledAcquisition, setSettledAcquisition] = React.useState<typeof acquisition | null>(null);
    const onContentSettled = React.useCallback(() => setSettledAcquisition(acquisition), [acquisition]);
    // Explicit scoped leaves demand a fresh snapshot even when their Session was never opened.
    // The existing list-content owner shares exact reads and live metadata updates, never messages.
    // Incumbent unscoped Summary/transcript callers retain their host-owned acquisition lifecycle.
    useSessionContentDemand(scopeRequired && serverId ? [{ serverId, sessionId }] : [], {
        active: currentScope && scopeRequired,
        hydrate: 'viewport', resetVersion, tag: 'session-awareness',
        onSettled: scopeRequired ? onContentSettled : undefined,
    });
    const liveSession = useSession(currentScope ? sessionId : '', currentScope ? serverId : null);
    // Summary retains its already-authorized shell while a live row is absent.
    // App transcripts deliberately provide no fallback and never invent activity.
    const session = currentScope ? liveSession ?? fallbackSession ?? null : null;
    const localNow = useSessionListRelativeNowMs(session !== null);
    const serverNow = React.useMemo(() => nowServerMs(), [localNow, session]);
    const wakeAt = React.useMemo(() => {
        if (!session) return null;
        const pending = derivePendingRequestFlagsFromSession(session, []);
        const expirations = readSessionRuntimePresentationFreshnessExpirations({
            ...session,
            ...pending,
            pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session, []),
        }, serverNow).filter((expiry) => expiry > serverNow);
        return expirations.length > 0 ? Math.min(...expirations) - (serverNow - localNow) : null;
    }, [localNow, serverNow, session]);
    useSessionListRuntimeWake(wakeAt, session !== null);
    const awareness = React.useMemo(() => session ? projectUiSessionAwareness(session, serverNow) : null, [serverNow, session]);
    const turnStartedAtMs = session ? readSessionTurnStartedAtMs(session) : null;
    const pendingRequests = React.useMemo(() => session && isSessionContentReadable(readSessionContentAvailability(session))
        // Explicit empty transcript prevents a same-id ambient transcript from another Home entering this scoped row.
        ? listPendingSessionRequests(session, []) : NO_PENDING_REQUESTS, [session]);
    const oldestPendingRequest = React.useMemo(() => selectOldestPendingRequest(pendingRequests), [pendingRequests]);
    const requestHref = oldestPendingRequest && serverId ? buildPermissionToolCallRoute({ sessionId, serverId, location: null }) : null;
    return { session, awareness, contentPending: scopeRequired && currentScope && settledAcquisition !== acquisition,
        turnStartedAtMs, pendingRequests, oldestPendingRequest, requestHref };
}
