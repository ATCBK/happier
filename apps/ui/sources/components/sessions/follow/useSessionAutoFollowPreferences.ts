import * as React from 'react';
import type { SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { sessionAutoFollowPreferencesGet, sessionAutoFollowPreferencesSet } from '@/sync/api/session/sessionFollowApi';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isAccountFollowConfigurationChangeRelevant } from './sessionFollowAccountChange';
import {
    createIdleSessionFollowMutationIntent,
    reduceSessionFollowMutationIntent,
    type SessionFollowMutationIntentEvent,
    type SessionFollowMutationIntentState,
} from './sessionFollowMutationIntent';
import {
    isServerReachabilityNetworkAllowed,
    subscribeServerReachabilityNetworkAllowed,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

/**
 * The intent is the fields the user changed, not a captured whole-preferences snapshot: a retry (or a
 * save that settles after a refresh) then applies that change to the current confirmed value instead
 * of resurrecting the rest of a stale object.
 */
export type SessionAutoFollowPreferencesIntent = Readonly<{ patch: Partial<SessionAutoFollowPreferencesV1> }>;

function reduceAutoFollowMutation(
    state: SessionFollowMutationIntentState<SessionAutoFollowPreferencesIntent>,
    event: SessionFollowMutationIntentEvent<SessionAutoFollowPreferencesIntent>,
): SessionFollowMutationIntentState<SessionAutoFollowPreferencesIntent> {
    return reduceSessionFollowMutationIntent(state, event);
}

/**
 * The one reader/writer of the Home's Follow preferences (`follow.preferences.get/set`): the
 * relationship defaults and the creation levels share this payload, so every settings surface that
 * edits any of it goes through this hook and its retry owner.
 */
export function useSessionAutoFollowPreferences(serverId: string) {
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId });
    const [preferences, setPreferences] = React.useState<SessionAutoFollowPreferencesV1 | null>(null);
    // The shared Follow retry owner: a failed preference change keeps its exact intent until a
    // retry succeeds, so a passive AccountChange or reconnect refresh cannot revert the switch
    // and leave an error row with nothing to retry.
    const [mutation, dispatchMutation] = React.useReducer(
        reduceAutoFollowMutation,
        createIdleSessionFollowMutationIntent<SessionAutoFollowPreferencesIntent>(),
    );
    const [saving, setSaving] = React.useState(false);
    const [online, setOnline] = React.useState(isServerReachabilityNetworkAllowed);
    const currentOperation = React.useRef<object | null>(null);
    const savingRef = React.useRef(false);
    const refreshAfterSaveRef = React.useRef(false);

    const refresh = React.useCallback(async () => {
        if (!enabled || !isServerReachabilityNetworkAllowed()) return;
        if (savingRef.current) {
            // AccountChange is only a content-free invalidation. Coalesce wakes while the
            // mutation owns this lifetime, then reconstruct the authoritative Home state
            // after settlement (the same serialization used by the Follow editor).
            refreshAfterSaveRef.current = true;
            return;
        }
        const operation = {};
        currentOperation.current = operation;
        const result = await sessionAutoFollowPreferencesGet(serverId);
        if (currentOperation.current !== operation) return;
        if (result.kind === 'ok') {
            setPreferences(result.value);
            dispatchMutation({ kind: 'refreshed' });
        } else {
            dispatchMutation({ kind: 'failed', error: true });
        }
    }, [enabled, serverId]);

    React.useEffect(() => {
        if (!enabled) return;
        let retired = false;
        const retire = () => {
            retired = true;
            currentOperation.current = null;
            setPreferences(null);
            dispatchMutation({ kind: 'abandoned' });
            setSaving(false);
            savingRef.current = false;
            refreshAfterSaveRef.current = false;
        };
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent()) return;
        const retirement = lifetime.onRetire(retire);
        const credentials = subscribeHomeCredentialMutations((event) => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) retire();
        });
        // The reachability subscription replays its current value synchronously on
        // subscribe. The mount read below owns the initial load, so only a genuine
        // offline → online transition reconciles here; otherwise every mount issued
        // two authoritative reads.
        let networkAllowed: boolean | null = null;
        const connection = subscribeServerReachabilityNetworkAllowed((next) => {
            if (retired) return;
            setOnline(next);
            const wasAllowed = networkAllowed;
            networkAllowed = next;
            if (next && wasAllowed === false) void refresh();
        });
        const changes = subscribeHomeAccountChange((event) => {
            if (!retired && areServerProfileIdentifiersEquivalent(event.serverId, serverId)
                && isAccountFollowConfigurationChangeRelevant(event)) void refresh();
        });
        // Load the current Account preference as soon as the settings section mounts.
        // Without this initial read, the section remains in its loading placeholder until
        // a reconnect or account-change event happens to trigger refresh().
        void refresh();
        return () => {
            // One retirement owner for this section lifetime: a teardown that reset only
            // part of it left the mutation gate closed, so a later lifetime (the feature
            // decision returning after a transient absence) deferred every refresh forever.
            retire();
            retirement.dispose();
            credentials();
            connection();
            changes();
        };
    }, [enabled, refresh, serverId]);

    const save = React.useCallback(async (intent: SessionAutoFollowPreferencesIntent) => {
        const base = preferences;
        if (!online || savingRef.current || !base) return;
        const operation = {};
        currentOperation.current = operation;
        savingRef.current = true;
        setSaving(true);
        dispatchMutation({ kind: 'started', intent });
        try {
            const result = await sessionAutoFollowPreferencesSet(serverId, { ...base, ...intent.patch });
            if (currentOperation.current !== operation) return;
            if (result.kind === 'ok') {
                setPreferences(result.value);
                dispatchMutation({ kind: 'succeeded' });
            } else {
                dispatchMutation({ kind: 'failed', error: true });
            }
        } catch {
            if (currentOperation.current === operation) dispatchMutation({ kind: 'failed', error: true });
        } finally {
            if (currentOperation.current !== operation) return;
            savingRef.current = false;
            setSaving(false);
            if (refreshAfterSaveRef.current) {
                refreshAfterSaveRef.current = false;
                await refresh();
            }
        }
    }, [online, preferences, refresh, serverId]);

    const outstanding = mutation.pending ?? mutation.failed;
    return {
        enabled,
        online,
        saving,
        error: mutation.error !== null,
        // The confirmed Home value is the baseline; an in-flight or failed change overlays it.
        displayed: preferences && outstanding ? { ...preferences, ...outstanding.patch } : preferences,
        save,
        /** Retries the exact change that failed; a failed load retries by loading again. */
        retry: () => { if (mutation.failed) void save(mutation.failed); else void refresh(); },
    };
}
