import * as React from 'react';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeListKey } from '@/sync/domains/scope/serverAccountScope';
import type { ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';

import {
    createSessionListViewFilterDefaults,
    normalizeSessionListViewFilters,
    removeUnavailableSessionListFilterSelections,
    type SessionListViewFilterDefaultsInput,
    type SessionListFilterDeletedSelections,
    type SessionListViewFilters,
    type SessionListViewContext,
} from './sessionListViewFilters';

type RetainedEntry = {
    filters: SessionListViewFilters;
    /**
     * The mounted-Home default this view was last seeded or cleared from.
     *
     * While the current Home selection still equals this baseline, nobody has made
     * an explicit Home choice yet, so a Home that finishes mounting later may join
     * the view. The moment the two diverge the choice is the person's, and no later
     * mount or probe change may overwrite it.
     */
    defaultHomeServerIds: readonly string[];
    /** Exact authenticated Home/Account lifetimes currently contributing to this view. */
    accountIdByServerId: Map<string, string>;
    defaults: SessionListViewFilterDefaultsInput;
};

function sameHomeSelection(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const known = new Set(a);
    return b.every((serverId) => known.has(serverId));
}

const retainedFiltersByKey = new Map<string, RetainedEntry>();
/** The one Sessions list: `global` is its retained view, whichever surface opens it. */
const GLOBAL_SESSION_LIST_CONTEXT_KEY = 'global';
const retainedFilterListeners = new Set<() => void>();
/** Asked for before the list ever mounted: its first mount opens already narrowed. */
let coordinatorsOnlyPending = false;
let unsubscribeCredentialChanges: (() => void) | null = null;

function ensureCredentialChangeSubscription(): void {
    if (unsubscribeCredentialChanges) return;
    unsubscribeCredentialChanges = subscribeHomeCredentialChange(({ serverId }) => {
        retireSessionListViewFilterCredentialContributions(serverId);
    });
}

function retentionKey(contextKey: string): string {
    return contextKey.trim();
}

function withCoordinatorsOnly(defaults: SessionListViewFilterDefaultsInput): SessionListViewFilterDefaultsInput {
    return { ...defaults, coordinator: 'coordinator' };
}

function getOrCreateEntry(
    contextKey: string,
    defaults: SessionListViewFilterDefaultsInput,
): RetainedEntry {
    ensureCredentialChangeSubscription();
    const key = retentionKey(contextKey);
    const existing = retainedFiltersByKey.get(key);
    if (existing) return existing;
    const filters = createSessionListViewFilterDefaults(
        key === GLOBAL_SESSION_LIST_CONTEXT_KEY && coordinatorsOnlyPending
            ? withCoordinatorsOnly(defaults)
            : defaults,
    );
    if (key === GLOBAL_SESSION_LIST_CONTEXT_KEY) coordinatorsOnlyPending = false;
    const entry: RetainedEntry = {
        filters,
        defaultHomeServerIds: filters.homeServerIds,
        accountIdByServerId: new Map(),
        defaults,
    };
    retainedFiltersByKey.set(key, entry);
    return entry;
}

function resetRetainedEntry(entry: RetainedEntry, defaults: SessionListViewFilterDefaultsInput): void {
    const filters = createSessionListViewFilterDefaults(defaults);
    entry.filters = filters;
    entry.defaultHomeServerIds = filters.homeServerIds;
}

function removeAuthoritativelyDeletedHomes(
    entry: RetainedEntry,
    filters: SessionListViewFilters,
    deletedHomeServerIds: readonly string[],
): SessionListViewFilters {
    const wasFollowingDefault = sameHomeSelection(filters.homeServerIds, entry.defaultHomeServerIds);
    const nextFilters = removeUnavailableSessionListFilterSelections(filters, {
        deletedHomeServerIds,
    });
    entry.filters = nextFilters;
    if (wasFollowingDefault) {
        const deleted = new Set(deletedHomeServerIds);
        entry.defaultHomeServerIds = entry.defaultHomeServerIds.filter((serverId) => !deleted.has(serverId));
    }
    return nextFilters;
}

function retireHomeAccountContribution(
    entry: RetainedEntry,
    serverId: string,
    defaults: SessionListViewFilterDefaultsInput,
): void {
    if (!entry.accountIdByServerId.delete(serverId)) return;
    if (entry.accountIdByServerId.size === 0) {
        resetRetainedEntry(entry, defaults);
        return;
    }
    removeAuthoritativelyDeletedHomes(entry, entry.filters, [serverId]);
}

function reconcileAccountScopeResolutions(
    entry: RetainedEntry,
    resolutions: ReadonlyMap<string, ServerCredentialAccountScopeResolution>,
    authoritativeHomeServerIds: readonly string[] | undefined,
    defaults: SessionListViewFilterDefaultsInput,
): void {
    const authoritativeHomes = authoritativeHomeServerIds
        ? new Set(authoritativeHomeServerIds)
        : null;
    for (const [serverId, accountId] of [...entry.accountIdByServerId]) {
        const resolution = resolutions.get(serverId);
        const retired = authoritativeHomes?.has(serverId) === false
            || resolution?.kind === 'signed_out'
            || resolution?.kind === 'unknown_home'
            || (resolution?.kind === 'bound' && resolution.scope.accountId !== accountId);
        if (retired) retireHomeAccountContribution(entry, serverId, defaults);
    }
    for (const [serverId, resolution] of resolutions) {
        if (resolution.kind === 'bound') {
            entry.accountIdByServerId.set(serverId, resolution.scope.accountId);
        }
    }
}

export function removeAuthoritativelyDeletedSessionListTagsForAccount(
    accountScope: ServerAccountScope,
    tagIds: readonly string[],
): void {
    const deletedTagIds = tagIds.map((tagId) => ({ serverId: accountScope.serverId, tagId }));
    for (const entry of retainedFiltersByKey.values()) {
        if (entry.accountIdByServerId.get(accountScope.serverId) !== accountScope.accountId) continue;
        entry.filters = removeUnavailableSessionListFilterSelections(entry.filters, { deletedTagIds });
    }
}

/** Credential mutation retires only that Home's contribution in every retained context. */
export function retireSessionListViewFilterCredentialContributions(serverIdRaw: string): void {
    const serverId = serverIdRaw.trim();
    if (!serverId) return;
    for (const entry of retainedFiltersByKey.values()) {
        // The next render supplies the current context defaults if this was the
        // final contribution. Until then, pruning the exact Home prevents the old
        // Account's qualified selections from remaining authoritative while its
        // replacement credential resolves.
        if (!entry.accountIdByServerId.delete(serverId)) continue;
        if (entry.accountIdByServerId.size === 0) {
            resetRetainedEntry(entry, entry.defaults);
        } else {
            removeAuthoritativelyDeletedHomes(entry, entry.filters, [serverId]);
        }
    }
}

export function buildSessionListViewCredentialScopeKey(
    contextKey: string,
    resolutions: ReadonlyMap<string, ServerCredentialAccountScopeResolution>,
    participatingServerIds: readonly string[],
): string {
    const serverIds = [...new Set(participatingServerIds.map((serverId) => serverId.trim()).filter(Boolean))].sort();
    const scopes = serverIds
        .flatMap((serverId) => {
            const resolution = resolutions.get(serverId);
            return resolution?.kind === 'bound' ? [resolution.scope] : [];
        })
        .sort((left, right) => left.serverId.localeCompare(right.serverId));
    return JSON.stringify([contextKey.trim(), serverIds, serverAccountScopeListKey(scopes)]);
}

/**
 * The intent behind "Show coordinators": the Sessions list shows its default view narrowed to
 * coordinators, whether it is mounted now or mounts later. The caller navigates to the list.
 * Resetting also clears any other facet, so the list is never left narrowed two ways.
 */
export function showOnlyCoordinatorsInSessionList(): void {
    const entry = retainedFiltersByKey.get(GLOBAL_SESSION_LIST_CONTEXT_KEY);
    if (!entry) {
        coordinatorsOnlyPending = true;
        return;
    }
    resetRetainedEntry(entry, withCoordinatorsOnly(entry.defaults));
    for (const listener of retainedFilterListeners) listener();
}

export function clearSessionListViewFilterRetentionForTests(): void {
    coordinatorsOnlyPending = false;
    retainedFiltersByKey.clear();
    unsubscribeCredentialChanges?.();
    unsubscribeCredentialChanges = null;
}

export type UseSessionListViewFiltersInput = Readonly<{
    /** `global` or a qualified Team-context key. */
    contextKey: string;
    defaults: SessionListViewFilterDefaultsInput;
    /** Fixed destination semantics, independent of its retention key or catalog. */
    viewContext?: SessionListViewContext;
    fixedShow?: SessionListViewFilters['show'];
    /** Existing exact-Home credential owner projection for every contributing Home. */
    accountScopeResolutions: ReadonlyMap<string, ServerCredentialAccountScopeResolution>;
    /**
     * Global Sessions mounts its Homes asynchronously, so an untouched default
     * follows the canonical mounted set. A Team context is fixed to its exact Home
     * and never reconciles.
     */
    followDefaultHomeSelection?: boolean;
    /** Complete current Home-profile scope from the authoritative local registry. */
    authoritativeHomeServerIds?: readonly string[];
}>;

export function useSessionListViewFilters(input: UseSessionListViewFiltersInput): Readonly<{
    filters: SessionListViewFilters;
    updateFilters: React.Dispatch<React.SetStateAction<SessionListViewFilters>>;
    setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
    /** Applies only identities an owning producer has explicitly proved deleted. */
    removeAuthoritativelyDeletedSelections: (deleted: SessionListFilterDeletedSelections) => void;
    resetFilters: () => void;
}> {
    const defaults = input.fixedShow ? { ...input.defaults, show: input.fixedShow } : input.defaults;
    const contextKey = input.contextKey.trim();
    const key = retentionKey(contextKey);
    const retained = React.useMemo(
        () => getOrCreateEntry(contextKey, defaults),
        [contextKey],
    );
    retained.defaults = defaults;
    const [state, setState] = React.useState<Readonly<{
        key: string;
        filters: SessionListViewFilters;
    }>>(() => ({ key, filters: retained.filters }));

    // A retained view can be changed from outside the list (Show coordinators); follow it.
    const [, followRetained] = React.useReducer((version: number) => version + 1, 0);
    React.useEffect(() => {
        retainedFilterListeners.add(followRetained);
        return () => { retainedFilterListeners.delete(followRetained); };
    }, []);

    reconcileAccountScopeResolutions(
        retained,
        input.accountScopeResolutions,
        input.authoritativeHomeServerIds,
        defaults,
    );

    let currentState = state;
    if (state.key === key && state.filters !== retained.filters) {
        currentState = { key, filters: retained.filters };
        setState(currentState);
    }
    if (state.key !== key) {
        currentState = { key, filters: retained.filters };
        setState(currentState);
    }

    if (input.authoritativeHomeServerIds) {
        const authoritativeHomeServerIds = new Set(input.authoritativeHomeServerIds);
        const deletedHomeServerIds = currentState.filters.homeServerIds
            .filter((serverId) => !authoritativeHomeServerIds.has(serverId));
        if (deletedHomeServerIds.length > 0) {
            const filters = removeAuthoritativelyDeletedHomes(
                retained,
                currentState.filters,
                deletedHomeServerIds,
            );
            currentState = { key, filters };
            setState(currentState);
        }
    }

    const mountedDefaultHomeServerIds = input.followDefaultHomeSelection === true
        ? createSessionListViewFilterDefaults(defaults).homeServerIds
        : currentState.filters.homeServerIds;
    if (
        input.followDefaultHomeSelection === true
        && sameHomeSelection(currentState.filters.homeServerIds, retained.defaultHomeServerIds)
        && !sameHomeSelection(currentState.filters.homeServerIds, mountedDefaultHomeServerIds)
    ) {
        const filters = normalizeSessionListViewFilters({
            ...currentState.filters,
            homeServerIds: mountedDefaultHomeServerIds,
        });
        retained.filters = filters;
        retained.defaultHomeServerIds = filters.homeServerIds;
        currentState = { key, filters };
        setState(currentState);
    }

    const updateFilters = React.useCallback<React.Dispatch<React.SetStateAction<SessionListViewFilters>>>((value) => {
        setState((current) => {
            const currentFilters = current.key === key ? current.filters : retained.filters;
            const requested = typeof value === 'function'
                ? (value as (previous: SessionListViewFilters) => SessionListViewFilters)(currentFilters)
                : value;
            const filters = normalizeSessionListViewFilters(requested, input.viewContext, input.fixedShow);
            retained.filters = filters;
            return { key, filters };
        });
    }, [input.fixedShow, input.viewContext, key, retained]);

    const setSearchQuery = React.useCallback<React.Dispatch<React.SetStateAction<string>>>((value) => {
        updateFilters((current) => ({
            ...current,
            searchQuery: typeof value === 'function'
                ? (value as (previous: string) => string)(current.searchQuery)
                : value,
        }));
    }, [updateFilters]);

    const removeAuthoritativelyDeletedSelections = React.useCallback((deleted: SessionListFilterDeletedSelections) => {
        setState((current) => {
            const currentFilters = current.key === key ? current.filters : retained.filters;
            const filters = removeUnavailableSessionListFilterSelections(currentFilters, deleted, input.viewContext);
            if (filters === currentFilters && current.key === key) return current;
            retained.filters = filters;
            return { key, filters };
        });
    }, [input.viewContext, key, retained]);

    const latestDefaults = React.useRef(defaults);
    latestDefaults.current = defaults;
    const resetFilters = React.useCallback(() => {
        const defaults = createSessionListViewFilterDefaults(latestDefaults.current);
        // Clearing re-enters default-following: the restored selection becomes the
        // new baseline, so Homes mounting after this point join again.
        retained.defaultHomeServerIds = defaults.homeServerIds;
        updateFilters(defaults);
    }, [retained, updateFilters]);

    return React.useMemo(() => ({
        filters: currentState.filters,
        updateFilters,
        setSearchQuery,
        removeAuthoritativelyDeletedSelections,
        resetFilters,
    }), [currentState.filters, removeAuthoritativelyDeletedSelections, resetFilters, setSearchQuery, updateFilters]);
}
