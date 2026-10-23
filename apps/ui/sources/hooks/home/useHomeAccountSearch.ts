import * as React from 'react';
import type { HomeAccountPickerRowV1 } from '@happier-dev/protocol/home/governance';

import { useSearch, type SearchRequestContext } from '@/hooks/search/useSearch';
import type { HomeActionFailure as HomeDomainFailure } from '@/sync/ops/home/homeActionOutcome';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { searchHomeAccounts } from '@/sync/ops/home/homeGovernanceOperations';

export type HomeAccountSearchState = Readonly<{
    rows: readonly HomeAccountPickerRowV1[];
    searching: boolean;
    /** The Home's own answer when the lookup failed; never inferred. */
    failure: HomeDomainFailure | null;
    retry: () => void;
}>;

const NO_ROWS: readonly HomeAccountPickerRowV1[] = Object.freeze([]);
type HomeAccountSearchAnswer = Pick<HomeAccountSearchState, 'rows' | 'failure'>;

/**
 * Finds a person on one exact Home.
 *
 * Debouncing, request supersession and result caching belong to the shared
 * search hook, so this adds only the Home call and the Home's typed refusal.
 * Keeping the refusal matters: a Home that has no such operation must be
 * explained as an older Home rather than shown as "no matches", which would be
 * a false answer about who is on it.
 *
 * Cached answers and typed refusals belong to the exact Home and Account,
 * including when a mounted search surface changes scope without remounting.
 */
export function useHomeAccountSearch(
    scope: ServerAccountScope | null,
    query: string,
    enabled: boolean,
): HomeAccountSearchState {
    const [retryFailure, setRetryFailure] = React.useState<Readonly<{
        scopeKey: string;
        query: string;
        value: HomeDomainFailure;
    }> | null>(null);
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const scopeKey = JSON.stringify([serverId, accountId]);
    React.useEffect(() => {
        if (!enabled) setRetryFailure(null);
    }, [enabled]);

    const search = React.useCallback(async (raw: string, request: SearchRequestContext): Promise<HomeAccountSearchAnswer[]> => {
        const trimmed = raw.trim();
        if (!enabled || !serverId || !accountId || trimmed.length === 0) {
            setRetryFailure(null);
            return [];
        }
        const outcome = await searchHomeAccounts({ scope: { serverId, accountId }, query: trimmed });
        if (!request.isCurrent()) return [];
        if (outcome.kind === 'failed') {
            // A Home that could not be reached is worth asking again, so the
            // shared hook's retry is allowed to run. A refusal or a Home with
            // no such operation has already answered: repeating the question
            // only delays telling the person what happened.
            if (outcome.failure.retryable) {
                setRetryFailure({ scopeKey, query: raw, value: outcome.failure });
                throw new Error('home_account_search_failed');
            }
            setRetryFailure(null);
            if (isAuthoritativeScopedSnapshotRefusalKind(outcome.failure.kind)) request.invalidateCache();
            return [{ rows: NO_ROWS, failure: outcome.failure }];
        }
        setRetryFailure(null);
        return [{ rows: [...outcome.value.accounts], failure: null }];
    }, [enabled, serverId, accountId, scopeKey]);

    const { results, isSearching, retry } = useSearch(query, search, scopeKey, enabled);
    const answer = results[0];

    return React.useMemo(() => Object.freeze({
        rows: answer?.rows.length ? answer.rows : NO_ROWS,
        searching: isSearching,
        failure: enabled && retryFailure?.scopeKey === scopeKey && retryFailure.query === query
            ? retryFailure.value
            : answer?.failure ?? null,
        retry,
    }), [answer, isSearching, retryFailure, retry, scopeKey, query, enabled]);
}
