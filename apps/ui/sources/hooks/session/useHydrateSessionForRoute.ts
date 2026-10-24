import * as React from 'react';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import type {
    EnsureSessionVisibleForRouteResult,
    SessionRouteHydrationState,
} from '@/sync/domains/session/sessionRouteHydrationState';
import { storage } from '@/sync/domains/state/storageStore';
import { sync } from '@/sync/sync';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { hasAuthoritativeSessionRouteData } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { t } from '@/text';

type SessionRouteHydrationStateRecord = Readonly<{
    routeKey: string;
    state: SessionRouteHydrationState;
}>;

function normalizeRouteId(value: unknown): string {
    return String(value ?? '').trim();
}

function areRouteServerIdsEqual(leftRaw: unknown, rightRaw: unknown): boolean {
    const left = normalizeRouteId(leftRaw);
    const right = normalizeRouteId(rightRaw);
    if (!left || !right) return left === right;
    return areServerProfileIdentifiersEquivalent(left, right);
}

function hasAuthoritativeHydratedSessionForRoute(sessionId: string, serverId?: string | null): boolean {
    const session = storage.getState().sessions[sessionId] ?? null;
    if (!session || !hasAuthoritativeSessionRouteData(session)) {
        return false;
    }
    if (serverId && !areRouteServerIdsEqual(String(session.serverId ?? '').trim(), serverId)) {
        return false;
    }
    if (session.encryptionMode === 'plain') {
        return true;
    }
    try {
        return hasAuthoritativeSessionRouteData(session, {
            hasSessionEncryption: Boolean(sync.encryption?.getSessionEncryption?.(sessionId)),
        });
    } catch {
        return hasAuthoritativeSessionRouteData(session, { hasSessionEncryption: false });
    }
}

function createLoadingState(
    sessionId: string,
    serverId: string | undefined,
    reason: Extract<SessionRouteHydrationState, { kind: 'loading' }>['reason'],
): SessionRouteHydrationState {
    return {
        kind: 'loading',
        sessionId,
        ...(serverId ? { serverId } : {}),
        reason,
    };
}

function createAvailableState(sessionId: string, serverId?: string): SessionRouteHydrationState {
    return {
        kind: 'available',
        sessionId,
        ...(serverId ? { serverId } : {}),
    };
}

function createRetryingState(
    sessionId: string,
    serverId: string | undefined,
    cause: Extract<SessionRouteHydrationState, { kind: 'retrying' }>['cause'],
): SessionRouteHydrationState {
    return {
        kind: 'retrying',
        sessionId,
        ...(serverId ? { serverId } : {}),
        cause,
    };
}

function createMissingState(
    sessionId: string,
    serverId: string | undefined,
    cause: Extract<SessionRouteHydrationState, { kind: 'missing' }>['cause'],
): SessionRouteHydrationState {
    return {
        kind: 'missing',
        sessionId,
        ...(serverId ? { serverId } : {}),
        cause,
    };
}

function readHydratedRouteServerId(sessionId: string, serverId?: string): string | undefined | null {
    if (hasAuthoritativeHydratedSessionForRoute(sessionId, serverId ?? null)) {
        if (serverId) return serverId;
        const hydratedServerId = normalizeRouteId(storage.getState().sessions[sessionId]?.serverId);
        return hydratedServerId || undefined;
    }

    return null;
}

function readHydratedRouteSnapshot(sessionId: string, serverId?: string): boolean {
    return readHydratedRouteServerId(sessionId, serverId) !== null;
}

function resolveHydratedServerIdForRouteResult(
    sessionId: string,
    routeServerId: string | undefined,
    resultServerId: string | null | undefined,
): string | undefined | null {
    return readHydratedRouteServerId(sessionId, routeServerId ?? (normalizeRouteId(resultServerId) || undefined));
}

/**
 * Best-effort hydration for deep links / hard refreshes.
 *
 * Some session sub-routes (e.g. fullscreen sidebar/details screens on mobile) can be opened directly
 * without mounting the main `SessionView`, which normally ensures the session exists in storage and
 * initializes its encryption state. Without this, any session-scoped RPC will fail with
 * "Session encryption not found".
 *
 * On failure, this hook retries with exponential backoff to handle transient errors
 * (server switch in flight, temporary RPC failure, stale encryption state, etc.).
 */
export function useHydrateSession(
    sessionId: string,
    tag: string,
    options?: Readonly<{ serverId?: string; forceRefresh?: boolean; hydrateMessages?: boolean; includeTurnsProjection?: boolean }>,
): SessionRouteHydrationState & Readonly<{ retry(): void }> {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedServerId = String(options?.serverId ?? '').trim();
    const routeServerId = normalizedServerId || undefined;
    const routeKey = `${routeServerId ?? ''}\n${normalizedSessionId}`;
    const forceRefresh = options?.forceRefresh === true;
    const hydrateMessages = options?.hydrateMessages;
    const includeTurnsProjection = options?.includeTurnsProjection;
    const hasHydratedSession = React.useSyncExternalStore(
        storage.subscribe,
        () => readHydratedRouteSnapshot(normalizedSessionId, routeServerId),
        () => readHydratedRouteSnapshot(normalizedSessionId, routeServerId),
    );
    const [routeStateRecord, setRouteStateRecord] = React.useState<SessionRouteHydrationStateRecord>(() => ({
        routeKey,
        state: !normalizedSessionId
            ? createMissingState('', routeServerId, 'not_found')
            : !forceRefresh && readHydratedRouteSnapshot(normalizedSessionId, routeServerId)
                ? createAvailableState(normalizedSessionId, routeServerId)
                : createLoadingState(normalizedSessionId, routeServerId, forceRefresh ? 'refreshing' : 'cold'),
    }));
    const retryCurrent = React.useRef<Readonly<{ routeKey: string; invoke(): void }> | null>(null);
    const retry = React.useCallback(() => {
        if (retryCurrent.current?.routeKey === routeKey) retryCurrent.current.invoke();
    }, [routeKey]);

    React.useEffect(() => {
        let canceled = false;
        let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let attemptCount = 0;
        let pending = false;

        if (!normalizedSessionId) {
            setRouteStateRecord({ routeKey, state: createMissingState('', routeServerId, 'not_found') });
            return;
        }
        const session = storage.getState().sessions[normalizedSessionId];
        const needsTurnsProjection = includeTurnsProjection === true
            && session !== undefined
            && session?.sessionTurns === undefined
            && isSessionContentReadable(readSessionContentAvailability(session));
        const alreadyAvailable = !forceRefresh && hasHydratedSession && !needsTurnsProjection;
        if (alreadyAvailable) {
            setRouteStateRecord({ routeKey, state: createAvailableState(normalizedSessionId, routeServerId) });
        } else {
            setRouteStateRecord({
                routeKey,
                state: createLoadingState(normalizedSessionId, routeServerId, forceRefresh ? 'refreshing' : 'store-miss'),
            });
        }

        const attemptHydration = (refresh = forceRefresh) => {
            if (canceled || pending) return;
            pending = true;

            attemptCount++;
            const hydrationOptions = {
                ...(refresh ? { forceRefresh: true } : {}),
                ...(routeServerId ? { serverId: routeServerId } : {}),
                ...(hydrateMessages !== undefined ? { hydrateMessages } : {}),
                ...(includeTurnsProjection !== undefined ? { includeTurnsProjection } : {}),
            };
            const promise = (sync.ensureSessionVisibleForMessageRoute as (
                sessionId: string,
                options?: Readonly<{ forceRefresh?: boolean; serverId?: string; hydrateMessages?: boolean; includeTurnsProjection?: boolean }>,
            ) => Promise<EnsureSessionVisibleForRouteResult>)(normalizedSessionId, Object.keys(hydrationOptions).length > 0 ? hydrationOptions : undefined);
            fireAndForget(promise, { tag });

            void promise
                .then((result) => {
                    if (canceled) return;
                    if (result.kind === 'missing') {
                        setRouteStateRecord({
                            routeKey,
                            state: createMissingState(
                                normalizedSessionId,
                                routeServerId ?? (normalizeRouteId(result.serverId) || undefined),
                                result.cause,
                            ),
                        });
                        return;
                    }
                    if (result.kind === 'available') {
                        const hydratedServerId = resolveHydratedServerIdForRouteResult(
                            normalizedSessionId,
                            routeServerId,
                            result.serverId,
                        );
                        if (hydratedServerId !== null) {
                            setRouteStateRecord({
                                routeKey,
                                state: createAvailableState(normalizedSessionId, hydratedServerId),
                            });
                            return;
                        }
                    }
                    setRouteStateRecord({
                        routeKey,
                        state: createRetryingState(
                            normalizedSessionId,
                            routeServerId,
                            result.kind === 'retryable_failure' ? result.cause : 'decrypting',
                        ),
                    });
                    // Retry with exponential backoff: 2s, 4s, 8s, 16s, max 30s
                    const retryDelayMs = Math.min(2000 * Math.pow(2, attemptCount - 1), 30000);
                    retryTimeoutId = setTimeout(() => {
                        if (!canceled) {
                            attemptHydration(refresh);
                        }
                    }, retryDelayMs);
                })
                .catch(() => {
                    if (canceled) return;
                    setRouteStateRecord({
                        routeKey,
                        state: createRetryingState(normalizedSessionId, routeServerId, 'unknown'),
                    });
                    // Retry with exponential backoff: 2s, 4s, 8s, 16s, max 30s
                    const retryDelayMs = Math.min(2000 * Math.pow(2, attemptCount - 1), 30000);
                    retryTimeoutId = setTimeout(() => {
                        if (!canceled) {
                            attemptHydration(refresh);
                        }
                    }, retryDelayMs);
                })
                .finally(() => { pending = false; });
        };

        const retryNow = () => {
            if (canceled || pending) return;
            if (retryTimeoutId !== null) {
                clearTimeout(retryTimeoutId);
                retryTimeoutId = null;
            }
            setRouteStateRecord({ routeKey, state: createLoadingState(normalizedSessionId, routeServerId, 'refreshing') });
            attemptHydration(true);
        };
        retryCurrent.current = { routeKey, invoke: retryNow };
        if (!alreadyAvailable) attemptHydration();

        return () => {
            canceled = true;
            if (retryCurrent.current?.invoke === retryNow) retryCurrent.current = null;
            if (retryTimeoutId !== null) {
                clearTimeout(retryTimeoutId);
            }
        };
    }, [forceRefresh, hasHydratedSession, hydrateMessages, includeTurnsProjection, normalizedSessionId, routeKey, routeServerId, tag]);

    const routeState = routeStateRecord.routeKey === routeKey
        ? routeStateRecord.state
        : createLoadingState(normalizedSessionId, routeServerId, 'server-switch');

    const hydratedAvailableServerId = normalizedSessionId && hasHydratedSession && routeState.kind !== 'missing'
        ? readHydratedRouteServerId(normalizedSessionId, routeServerId) ?? routeServerId
        : null;
    const hydratedAvailableState = React.useMemo<SessionRouteHydrationState | null>(() => {
        if (hydratedAvailableServerId === null) return null;
        return createAvailableState(normalizedSessionId, hydratedAvailableServerId);
    }, [hydratedAvailableServerId, normalizedSessionId]);

    const currentState = hydratedAvailableState ?? routeState;
    return React.useMemo(() => ({ ...currentState, retry }), [currentState, retry]);
}

/** Route identity is published only by route consumers, never embedded or background Session reads. */
export function useHydrateSessionForRoute(
    sessionId: string,
    tag: string,
    options?: Parameters<typeof useHydrateSession>[2],
): SessionRouteHydrationState {
    // An opened transcript needs the bounded turn facts for grouping and workflow folds.
    // Detail-only/background readers keep using the same hydration owner without that demand.
    const result = useHydrateSession(sessionId, tag, {
        ...options,
        includeTurnsProjection: options?.includeTurnsProjection ?? options?.hydrateMessages !== false,
    });
    // The route read owns absence; a loaded list/cache alone cannot establish it.
    useDestinationPageTitle(result.kind === 'missing' ? t('errors.sessionDeleted') : undefined);
    return result;
}
