import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getStorage, useSessionDisplayNameProjections } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readableSessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { selectDiscussionListSearch, type DiscussionRepository, type DiscussionRepositoryListSnapshot } from './discussionRepository';

const RETIRED_LIST: DiscussionRepositoryListSnapshot = Object.freeze({
    items: [], status: 'revoked', errorCode: 'discussion_read_denied', nextCursor: null, incomplete: true,
});

export type DiscussionListSearchSnapshot = DiscussionRepositoryListSnapshot & Readonly<{
    /** Active-query availability only, not pending work or corpus incompleteness; false when not searching. */
    sourceLabelsUnavailable: boolean;
}>;

/** Open-list demand only: paginate the selected corpus, then search its already-opened display facts. */
export function useDiscussionListSearch(input: Readonly<{
    repository: DiscussionRepository;
    scope: ServerAccountScope;
    accountLifetime: ServerAccountScopeLifetime;
    query: string;
    state: 'active' | 'archived';
    anchorSessionId?: string;
}>): DiscussionListSearchSnapshot {
    const { repository, scope, accountLifetime, query, state, anchorSessionId } = input;
    const readList = React.useCallback(() => repository.getListSnapshot(anchorSessionId).lists[state], [repository, anchorSessionId, state]);
    const list = React.useSyncExternalStore(repository.subscribe, readList, readList);
    const subscribeLifetime = React.useCallback((notify: () => void) => {
        const retirement = accountLifetime.onRetire(notify);
        return () => retirement.dispose();
    }, [accountLifetime]);
    const readCurrent = React.useCallback(() => accountLifetime.isCurrent()
        && areServerAccountScopesEqual(accountLifetime.scope, scope), [accountLifetime, scope.serverId, scope.accountId]);
    const current = React.useSyncExternalStore(subscribeLifetime, readCurrent, readCurrent);
    const searching = current && query.trim().length > 0;
    const visible = current ? list : RETIRED_LIST;
    const abort = React.useMemo(() => searching ? new AbortController() : null, [searching, repository, anchorSessionId, state, accountLifetime]);
    React.useEffect(() => {
        if (!abort) return;
        const retirement = accountLifetime.onRetire(() => abort.abort());
        return () => { retirement.dispose(); abort.abort(); };
    }, [abort, accountLifetime]);
    React.useEffect(() => {
        if (!abort || abort.signal.aborted || !accountLifetime.isCurrent()) return;
        if (list.status === 'idle' || ((list.status === 'ready' || list.status === 'locked') && list.nextCursor)) {
            void repository.loadCompleteList(state, abort.signal, anchorSessionId);
        }
    }, [abort, accountLifetime, repository, anchorSessionId, state, list.status, list.nextCursor]);

    const addresses = React.useMemo(() => [...new Set(searching ? visible.items.flatMap(row => [
        ...(row.anchor?.kind === 'session' ? [row.anchor.sessionId] : []), ...(row.participantSessionIds ?? []),
    ]) : [])].map(sessionId => ({ serverId: scope.serverId, sessionId })), [searching, visible.items, scope.serverId]);
    const sessionTitles = useSessionDisplayNameProjections(addresses, readableSessionDisplayTitle);
    const docIds = React.useMemo(() => searching ? [...new Set(visible.items.flatMap(row =>
        row.anchor?.kind === 'doc' && areServerProfileIdentifiersEquivalent(row.anchor.doc.ref.serverId, scope.serverId)
            ? [row.anchor.doc.ref.artifactId] : []))] : [], [searching, visible.items, scope.serverId]);
    // Artifact headers already opened for this exact Account/Home are sufficient. No source body read.
    const docTitles = getStorage()(useShallow(storage => docIds.map(id => {
        if (!areServerAccountScopesEqual(storage.profileScope, scope)) return null;
        const artifact = storage.artifacts[id];
        return artifact?.isDecrypted === true && !artifact.draft ? artifact.title : null;
    })));
    const sourceDisplay = React.useMemo(() => {
        const sessions = new Map(addresses.map((address, index) => [address.sessionId, sessionTitles[index]]));
        const docs = new Map(docIds.map((id, index) => [id, docTitles[index]]));
        let unavailable = false;
        const labels = new Map(visible.items.map(row => {
            const values = [
                ...(row.anchor?.kind === 'session' ? [sessions.get(row.anchor.sessionId)] : []),
                ...(row.anchor?.kind === 'doc' ? [areServerProfileIdentifiersEquivalent(row.anchor.doc.ref.serverId, scope.serverId)
                    ? docs.get(row.anchor.doc.ref.artifactId) : undefined] : []),
                ...(row.participantSessionIds ?? []).map(id => sessions.get(id)),
            ];
            // Task source labels have no admitted client reader yet. That is
            // unavailable display data, not a request to invent or fetch a title.
            if (row.anchor?.kind === 'task' || values.some(label => !label)) unavailable = true;
            return [row.id, values.filter((label): label is string => typeof label === 'string' && label.length > 0)] as const;
        }));
        return { labels, unavailable: searching && unavailable };
    }, [searching, visible.items, addresses, sessionTitles, docIds, docTitles, scope.serverId]);
    const previous = React.useRef<DiscussionListSearchSnapshot | undefined>(undefined);
    return React.useMemo(() => {
        const selected = selectDiscussionListSearch(visible, query, sourceDisplay.labels, previous.current);
        const result = selected === previous.current && previous.current.sourceLabelsUnavailable === sourceDisplay.unavailable
            ? previous.current : { ...selected, sourceLabelsUnavailable: sourceDisplay.unavailable };
        previous.current = result;
        return result;
    }, [visible, query, sourceDisplay]);
}
