import { normalizeSessionListFilterV1, type SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import type { SessionListViewFilters } from './sessionListViewFilters';

/**
 * A stored `SessionListFilterV1` (a Board's inline filter, the composer's Matching sessions) is edited
 * with the Sessions list's own editor. These two adapters are the whole difference: a filter that names
 * no Home means every mounted Home (as the list does), and only the selection is stored — never search text.
 */
export function fromStoredSessionListFilter(filter: SessionListFilterV1, mountedServerIds: readonly string[]): SessionListViewFilters {
    const homeServerIds = filter.homeServerIds.length > 0 ? filter.homeServerIds : mountedServerIds;
    return { ...normalizeSessionListFilterV1({ ...filter, homeServerIds }), searchQuery: '' };
}

export function toStoredSessionListFilter(filters: SessionListViewFilters): SessionListFilterV1 {
    const { searchQuery: _searchQuery, ...selection } = filters;
    return normalizeSessionListFilterV1(selection);
}
