import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { DiscussionRepositorySnapshot } from '@/sync/ops/discussions/discussionRepository';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import type { DiscussionHomeAddress } from './discussionDetailsTarget';

const NO_TITLES: ReadonlyMap<string, string> = new Map();
const NO_SERVER_IDS: readonly string[] = Object.freeze([]);

function readTitles(snapshot: DiscussionRepositorySnapshot | null, discussionIds: readonly string[]): ReadonlyMap<string, string> {
    if (!snapshot || discussionIds.length === 0) return NO_TITLES;
    const titles = new Map<string, string>();
    const wanted = new Set(discussionIds);
    for (const item of [...snapshot.lists.active.items, ...snapshot.lists.archived.items]) {
        const title = item.title?.trim();
        if (title && wanted.has(item.id)) titles.set(item.id, title);
    }
    for (const discussionId of discussionIds) {
        const title = snapshot.threads[discussionId]?.summary?.title?.trim();
        if (title && !titles.has(discussionId)) titles.set(discussionId, title);
    }
    return titles.size === 0 ? NO_TITLES : titles;
}

/**
 * The titles of Home conversations, for surfaces that name one without opening it:
 * an Agent conversation says it came "from Relay retry plan".
 *
 * Reads the one shared Home/Account Discussion repository (the list and Details surfaces use the
 * same instance), so a title is never fetched or decrypted twice. It subscribes only while it has
 * ids to name, and asks the repository for a discussion it has not seen yet exactly once; a title
 * that stays unknown (feature off, encrypted, access removed) is simply absent and the caller falls
 * back to a generic origin.
 */
export function useDiscussionTitles(input: Readonly<{
    address: DiscussionHomeAddress | null;
    discussionIds: readonly string[];
}>): ReadonlyMap<string, string> {
    const serverId = input.address?.serverId ?? '';
    const wanted = input.address !== null && input.discussionIds.length > 0;
    const requestedServerIds = React.useMemo(() => wanted ? [serverId] : NO_SERVER_IDS, [serverId, wanted]);
    const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    const availability = useSessionCollaborationAvailability(serverId);
    const enabled = useFeatureEnabled('sessions.conversations', { scopeKind: 'spawn', serverId });
    const address = input.address;
    const repository = React.useMemo(() => {
        if (!wanted || !address || !binding || !enabled || availability !== 'available') return null;
        return getDiscussionRepository({
            scope: binding.scope,
            address,
            client: createDiscussionClient({ scope: binding.scope, availability: 'available' }),
            accountLifetime: binding,
        });
    }, [address, availability, binding, enabled, wanted]);
    const subscribe = React.useCallback(
        (listener: () => void) => repository ? repository.subscribe(listener) : () => undefined,
        [repository],
    );
    const read = React.useCallback(() => repository?.getSnapshot() ?? null, [repository]);
    const snapshot = React.useSyncExternalStore(subscribe, read, read);
    React.useEffect(() => repository?.mount(), [repository]);

    const idsKey = input.discussionIds.join('\u0000');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the id set, not the array identity
    const discussionIds = React.useMemo(() => input.discussionIds, [idsKey]);
    const titles = React.useMemo(() => readTitles(snapshot, discussionIds), [discussionIds, snapshot]);

    const requested = React.useRef(new Set<string>());
    React.useEffect(() => {
        requested.current = new Set();
    }, [repository]);
    React.useEffect(() => {
        if (!repository || !snapshot) return;
        for (const discussionId of discussionIds) {
            if (titles.has(discussionId) || requested.current.has(discussionId)) continue;
            if (snapshot.threads[discussionId]) continue;
            requested.current.add(discussionId);
            void repository.refreshDiscussion(discussionId);
        }
    }, [discussionIds, repository, snapshot, titles]);

    return titles;
}
