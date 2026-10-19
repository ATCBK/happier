import * as React from 'react';
import type { HomeAccountPickerRowV1 } from '@happier-dev/protocol/home/governance';

import { useSearch, type SearchRequestContext } from '@/hooks/search/useSearch';
import type { HomeActionFailure as HomeDomainFailure } from '@/sync/ops/home/homeActionOutcome';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { searchHomeAccounts } from '@/sync/ops/home/homeGovernanceOperations';

export type HomeAccountSearchState = Readonly<{
    rows: readonly HomeAccountPickerRowV1[];
    searching: boolean;
    /** The Home's own answer when the lookup failed; never inferred. */
    failure: HomeDomainFailure | null;
    retry: () => void;
}>;

const NO_ROWS: readonly HomeAccountPickerRowV1[] = Object.freeze([]);

/**
 * Finds a person on one exact Home.
 *
 * Debouncing, request supersession and result caching belong to the shared
 * search hook, so this adds only the Home call and the Home's typed refusal.
 * Keeping the refusal matters: a Home that has no such operation must be
 * explained as an older Home rather than shown as "no matches", which would be
 * a false answer about who is on it.
 *
 * The shared hook caches by query for its component's lifetime, so a surface
 * that can change Home or Account underneath it must remount this hook — see
 * the People screen, which keys its search section by scope.
 */
export function useHomeAccountSearch(
    scope: ServerAccountScope | null,
    query: string,
    enabled: boolean,
): HomeAccountSearchState {
    const [failure, setFailure] = React.useState<HomeDomainFailure | null>(null);
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';

    const search = React.useCallback(async (raw: string, request: SearchRequestContext): Promise<HomeAccountPickerRowV1[]> => {
        const trimmed = raw.trim();
        if (!enabled || !serverId || !accountId || trimmed.length === 0) {
            setFailure(null);
            return [];
        }
        const outcome = await searchHomeAccounts({ scope: { serverId, accountId }, query: trimmed });
        if (!request.isCurrent()) return [];
        if (outcome.kind === 'failed') {
            setFailure(outcome.failure);
            // A Home that could not be reached is worth asking again, so the
            // shared hook's retry is allowed to run. A refusal or a Home with
            // no such operation has already answered: repeating the question
            // only delays telling the person what happened.
            if (outcome.failure.retryable) throw new Error('home_account_search_failed');
            return [];
        }
        setFailure(null);
        return [...outcome.value.accounts];
    }, [enabled, serverId, accountId]);

    const { results, isSearching, retry } = useSearch(query, search);

    return React.useMemo(() => Object.freeze({
        rows: results.length > 0 ? results : NO_ROWS,
        searching: isSearching,
        failure,
        retry,
    }), [results, isSearching, failure, retry]);
}
