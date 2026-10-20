import * as React from 'react';

import { listSessionFollowSources } from '@/sync/api/session/sessionFollowSourcesApi';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { isSessionFollowAccountChangeRelevant } from './sessionFollowAccountChange';

type FollowingResult = Awaited<ReturnType<typeof listSessionFollowSources>>;
export type SessionFollowingProjection = Extract<FollowingResult, { kind: 'ok' }>['value'];
export type SessionFollowingController = Readonly<{
    projection: SessionFollowingProjection | null;
    loading: boolean;
    error: string | null;
    refresh(): Promise<void>;
}>;
type FollowingState = Readonly<{
    key: string;
    projection: SessionFollowingProjection | null;
    loading: boolean;
    error: string | null;
}>;
type ReadFlight = {
    key: string;
    controller: AbortController;
    dirty: boolean;
    settled: Promise<void>;
};

/** One Following census, including opened private rules, shared by pane and directional sheet. */
export function useSessionFollowing(address: SessionAddress | null, enabled: boolean): SessionFollowingController {
    const serverId = address?.serverId;
    const sessionId = address?.sessionId;
    const activeScope = useActiveServerAccountScope();
    const currentScope = selectActiveServerAccountScopeForServer(activeScope, serverId ?? null);
    const { binding, resolution } = useServerCredentialAccountScopeBinding(enabled && !currentScope ? serverId : null);
    const activeLifetime = currentScope ? captureActiveServerAccountScopeLifetime() : null;
    const lifetime = currentScope ? activeLifetime : binding;
    const accountId = currentScope?.accountId ?? binding?.accountId;
    const key = JSON.stringify([serverId, sessionId, accountId, binding?.revision]);
    const [state, setState] = React.useState<FollowingState>({ key: '', projection: null, loading: false, error: null });
    const readFlightRef = React.useRef<ReadFlight | null>(null);
    const sourceIdsRef = React.useRef<ReadonlySet<string>>(new Set());

    const refresh = React.useCallback((): Promise<void> => {
        if (!enabled || !serverId || !sessionId || !lifetime?.isCurrent()) return Promise.resolve();
        const running = readFlightRef.current;
        if (running?.key === key && !running.controller.signal.aborted) {
            running.dirty = true;
            return running.settled;
        }
        const flight: ReadFlight = { key, controller: new AbortController(), dirty: false, settled: Promise.resolve() };
        const isCurrent = () => !flight.controller.signal.aborted && lifetime.isCurrent();
        flight.settled = (async () => {
            try {
                do {
                    flight.dirty = false;
                    setState(current => ({ key, projection: current.key === key ? current.projection : null, loading: true, error: null }));
                    const result = await listSessionFollowSources({ serverId, sessionId }, flight.controller.signal, accountId)
                        .catch(() => ({ kind: 'failed', error: 'unavailable' } as const));
                    if (!isCurrent()) return;
                    if (result.kind === 'ok') {
                        sourceIdsRef.current = new Set(result.value.sources.flatMap(source => (
                            'sourceSessionId' in source ? [source.sourceSessionId] : []
                        )));
                        setState({ key, projection: result.value, loading: false, error: null });
                    } else {
                        setState(current => ({ key,
                            projection: result.error === 'unavailable' && current.key === key ? current.projection : null,
                            loading: false, error: result.error }));
                    }
                } while (flight.dirty && isCurrent());
            } finally {
                if (readFlightRef.current === flight) readFlightRef.current = null;
            }
        })();
        readFlightRef.current = flight;
        return flight.settled;
    }, [accountId, enabled, key, lifetime, serverId, sessionId]);

    React.useEffect(() => {
        sourceIdsRef.current = new Set();
        const retirement = lifetime?.onRetire(() => {
            if (readFlightRef.current?.key === key) readFlightRef.current.controller.abort();
            setState({ key, projection: null, loading: false, error: 'action_account_scope_changed' });
        });
        void refresh();
        return () => {
            if (readFlightRef.current?.key === key) readFlightRef.current.controller.abort();
            retirement?.dispose();
        };
    }, [key, lifetime, refresh]);

    React.useEffect(() => {
        if (!enabled || !lifetime?.isCurrent() || !serverId || !sessionId) return;
        return subscribeHomeAccountChange(event => {
            if (!lifetime.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, serverId)) return;
            if (!isSessionFollowAccountChangeRelevant(event, new Set([sessionId, ...sourceIdsRef.current]))) return;
            void refresh();
        });
    }, [enabled, lifetime, refresh, serverId, sessionId]);

    const visible = enabled && lifetime?.isCurrent() && state.key === key ? state : null;
    return {
        projection: visible?.projection ?? null,
        loading: enabled && Boolean(address) && ((!currentScope && resolution.kind === 'resolving') || Boolean(lifetime?.isCurrent() && (!visible || visible.loading))),
        error: visible?.error ?? (enabled && address && !currentScope && resolution.kind !== 'bound' && resolution.kind !== 'resolving' ? 'unavailable' : null),
        refresh,
    };
}
