import * as React from 'react';

import { listSessionFollowSources } from '@/sync/api/session/sessionFollowSourcesApi';
import { readSessionFollowRuleInputs, type SessionFollowRulesReadResult } from '@/sync/api/session/sessionFollowRulesApi';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { isAccountFollowConfigurationChangeRelevant, isSessionFollowAccountChangeRelevant } from './sessionFollowAccountChange';
import type { SessionFollowRulesController } from './useSessionFollowRules';

type FollowingResult = Awaited<ReturnType<typeof listSessionFollowSources>>;
export type SessionFollowingProjection = Extract<FollowingResult, { kind: 'ok' }>['value'];
export type SessionFollowingController = Readonly<{
    projection: SessionFollowingProjection | null;
    loading: boolean;
    error: string | null;
    ruleInputs: SessionFollowRulesController;
    refresh(): Promise<void>;
}>;
type FollowingState = Readonly<{
    key: string;
    projection: SessionFollowingProjection | null;
    loading: boolean;
    error: string | null;
    ruleSnapshot: SessionFollowRulesReadResult | null;
}>;
type ReadFlight = {
    key: string;
    controller: AbortController;
    dirty: boolean;
    refreshRules: boolean;
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
    const [state, setState] = React.useState<FollowingState>({ key: '', projection: null, loading: false, error: null, ruleSnapshot: null });
    const readFlightRef = React.useRef<ReadFlight | null>(null);
    const ruleInputRef = React.useRef<Readonly<{ key: string; snapshot: SessionFollowRulesReadResult }> | null>(null);
    const sourceIdsRef = React.useRef<ReadonlySet<string>>(new Set());

    const read = React.useCallback((refreshRules: boolean): Promise<void> => {
        if (!enabled || !serverId || !sessionId || !lifetime?.isCurrent()) return Promise.resolve();
        const running = readFlightRef.current;
        if (running?.key === key && !running.controller.signal.aborted) {
            running.dirty = true;
            running.refreshRules ||= refreshRules;
            return running.settled;
        }
        const flight: ReadFlight = { key, controller: new AbortController(), dirty: false, refreshRules, settled: Promise.resolve() };
        const isCurrent = () => !flight.controller.signal.aborted && lifetime.isCurrent();
        flight.settled = (async () => {
            try {
                do {
                    flight.dirty = false;
                    setState(current => ({ key, projection: current.key === key ? current.projection : null, loading: true, error: null,
                        ruleSnapshot: current.key === key ? current.ruleSnapshot : null }));
                    if (flight.refreshRules || ruleInputRef.current?.key !== key) {
                        flight.refreshRules = false;
                        const snapshot = await readSessionFollowRuleInputs(serverId, flight.controller.signal, { expectedAccountId: accountId });
                        if (!isCurrent()) return;
                        ruleInputRef.current = { key, snapshot };
                    }
                    const ruleSnapshot = ruleInputRef.current!.snapshot;
                    const result = await listSessionFollowSources({ serverId, sessionId }, flight.controller.signal, accountId, { rules: ruleSnapshot })
                        .catch(() => ({ kind: 'failed', error: 'unavailable' } as const));
                    if (!isCurrent()) return;
                    if (result.kind === 'ok') {
                        sourceIdsRef.current = new Set(result.value.sources.flatMap(source => (
                            'sourceSessionId' in source ? [source.sourceSessionId] : []
                        )));
                        setState({ key, projection: result.value, loading: false, error: null, ruleSnapshot });
                    } else {
                        setState(current => ({ key,
                            projection: result.error === 'unavailable' && current.key === key ? current.projection : null,
                            loading: false, error: result.error, ruleSnapshot }));
                    }
                } while (flight.dirty && isCurrent());
            } finally {
                if (readFlightRef.current === flight) readFlightRef.current = null;
            }
        })();
        readFlightRef.current = flight;
        return flight.settled;
    }, [accountId, enabled, key, lifetime, serverId, sessionId]);
    const refresh = React.useCallback(() => read(true), [read]);

    React.useEffect(() => {
        sourceIdsRef.current = new Set();
        ruleInputRef.current = null;
        const retirement = lifetime?.onRetire(() => {
            if (readFlightRef.current?.key === key) readFlightRef.current.controller.abort();
            ruleInputRef.current = null;
            setState({ key, projection: null, loading: false, error: 'action_account_scope_changed', ruleSnapshot: null });
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
            const configurationChanged = isAccountFollowConfigurationChangeRelevant(event);
            if (!configurationChanged && !isSessionFollowAccountChangeRelevant(event, new Set([sessionId, ...sourceIdsRef.current]))) return;
            void read(configurationChanged);
        });
    }, [enabled, lifetime, read, serverId, sessionId]);

    const visible = enabled && lifetime?.isCurrent() && state.key === key ? state : null;
    const loading = enabled && Boolean(address) && ((!currentScope && resolution.kind === 'resolving')
        || Boolean(lifetime?.isCurrent() && (!visible || visible.loading)));
    return {
        projection: visible?.projection ?? null,
        loading,
        error: visible?.error ?? (enabled && address && !currentScope && resolution.kind !== 'bound' && resolution.kind !== 'resolving' ? 'unavailable' : null),
        ruleInputs: { snapshot: visible?.ruleSnapshot ?? null, lifetime, accountId, refresh, loading },
        refresh,
    };
}
