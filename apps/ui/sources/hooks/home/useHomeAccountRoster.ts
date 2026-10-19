import * as React from 'react';
import type { HomeAccountRowV1 } from '@happier-dev/protocol/home/governance';

import type { HomeActionFailure as HomeDomainFailure } from '@/sync/ops/home/homeActionOutcome';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { listHomeAccounts } from '@/sync/ops/home/homeGovernanceOperations';
import {
    isHomeAdministrationAccountChange,
    subscribeHomeAccountChange,
} from '@/sync/runtime/orchestration/homeAccountChange';

export type HomeAccountRosterStatus = 'loading' | 'loading_more' | 'ready' | 'error';

export type HomeAccountRoster = Readonly<{
    rows: readonly HomeAccountRowV1[];
    /** Exact Home total when supplied; null for an older list response. */
    total: number | null;
    status: HomeAccountRosterStatus;
    /** Retained across a failed page load so the list never blanks. */
    error: HomeDomainFailure | null;
    hasMore: boolean;
    loadMore: () => void;
    reload: () => void;
}>;

type RosterState = Readonly<{
    rows: readonly HomeAccountRowV1[];
    total: number | null;
    status: HomeAccountRosterStatus;
    error: HomeDomainFailure | null;
    cursor: string | null;
    /** False once the Home has answered with no further cursor. */
    hasMore: boolean;
}>;

const INITIAL: RosterState = Object.freeze({
    rows: Object.freeze([]) as readonly HomeAccountRowV1[],
    total: null,
    status: 'loading' as const,
    error: null,
    cursor: null,
    hasMore: true,
});

/**
 * The Home's People list for one exact Home and Account.
 *
 * Pages accumulate in order and are never dropped by a later failure: a Home
 * that stops answering midway leaves the pages already read on screen with a
 * retry, which is far more useful to an administrator than an empty list.
 *
 * This is a paged read, not a cache with its own invalidation policy. It reloads
 * when the caller asks and when the Home it is bound to changes, and it makes no
 * claim about rows the Home has not yet returned.
 */
export function useHomeAccountRoster(
    scope: ServerAccountScope | null,
    enabled: boolean,
): HomeAccountRoster {
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';

    const [state, setState] = React.useState<RosterState>(INITIAL);
    // Answers for a superseded Home or a superseded reload must not be applied.
    const generation = React.useRef(0);
    // The position the Home last handed back. A continuation has to read it
    // before the request is composed, so it cannot be taken from inside a state
    // updater: React runs those during the next render, by which time the
    // request would already have been sent without a cursor and would have
    // re-read the first page forever.
    const latest = React.useRef<RosterState>(INITIAL);
    React.useEffect(() => {
        latest.current = state;
    }, [state]);

    const load = React.useCallback((mode: 'reset' | 'refresh' | 'more') => {
        if (!enabled || !serverId || !accountId) return;
        const current = latest.current;
        if (mode === 'more'
            && (!current.hasMore || current.status === 'loading' || current.status === 'loading_more')) {
            return;
        }
        const cursor = mode === 'more' ? current.cursor : null;
        const currentGeneration = mode === 'more' ? generation.current : (generation.current += 1);
        setState((previous) => {
            if (mode === 'reset') return { ...INITIAL, status: 'loading' };
            if (mode === 'refresh') {
                return { ...previous, status: 'loading', error: null, cursor: null, hasMore: true };
            }
            return { ...previous, status: 'loading_more', error: null };
        });

        void (async () => {
            const outcome = await listHomeAccounts({
                scope: { serverId, accountId },
                ...(cursor ? { cursor } : {}),
            });
            if (currentGeneration !== generation.current) return;
            setState((previous) => {
                if (outcome.kind === 'failed') {
                    return { ...previous, status: 'error', error: outcome.failure };
                }
                const incoming = outcome.value.items;
                return {
                    rows: mode === 'more' ? [...previous.rows, ...incoming] : incoming,
                    total: outcome.value.total ?? null,
                    status: 'ready',
                    error: null,
                    cursor: outcome.value.nextCursor,
                    hasMore: outcome.value.nextCursor !== null,
                };
            });
        })();
    }, [enabled, serverId, accountId]);

    React.useEffect(() => {
        if (!enabled || !serverId || !accountId) {
            generation.current += 1;
            latest.current = INITIAL;
            setState(INITIAL);
            return;
        }
        load('reset');
    }, [enabled, serverId, accountId, load]);

    React.useEffect(() => {
        if (!enabled || !serverId || !accountId) return;
        return subscribeHomeAccountChange((event) => {
            if (event.serverId === serverId && isHomeAdministrationAccountChange(event)) load('refresh');
        });
    }, [enabled, serverId, accountId, load]);

    const loadMore = React.useCallback(() => { load('more'); }, [load]);
    const reload = React.useCallback(() => { load('refresh'); }, [load]);

    return React.useMemo(() => Object.freeze({
        rows: state.rows,
        total: state.total,
        status: state.status,
        error: state.error,
        hasMore: state.hasMore,
        loadMore,
        reload,
    }), [state, loadMore, reload]);
}
