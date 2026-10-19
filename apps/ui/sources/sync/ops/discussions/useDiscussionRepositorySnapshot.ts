import * as React from 'react';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { readRegisteredDiscussionRepository, subscribeRegisteredDiscussionRepository } from './discussionRepositoryRegistry';

import type {
    DiscussionRepository,
    DiscussionRepositorySnapshot,
} from './discussionRepository';

/** The single React projection seam for the shared Home Discussion repository. */
export function useDiscussionRepositorySnapshot(
    repository: DiscussionRepository,
): DiscussionRepositorySnapshot {
    return React.useSyncExternalStore(
        repository.subscribe,
        repository.getSnapshot,
        repository.getSnapshot,
    );
}

function readDiscussionSnapshotTitle(snapshot: DiscussionRepositorySnapshot | undefined, discussionId: string): string | null {
    const summary = snapshot?.lists.active.items.find(row => row.id === discussionId)
        ?? snapshot?.lists.archived.items.find(row => row.id === discussionId)
        ?? snapshot?.threads[discussionId]?.summary;
    return summary?.title ?? null;
}

/** A non-fetching snapshot only for the proven active Home/Account; other Homes need a live binding. */
export function readDiscussionTitle(address: Readonly<{ serverId: string | null; discussionId: string }>): string | null {
    const serverId = resolveServerProfileScopeIdForIdentifier(address.serverId);
    const scope = selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), serverId);
    if (!scope) return null;
    return readDiscussionSnapshotTitle(readRegisteredDiscussionRepository(scope, { ...address, serverId })?.getSnapshot(), address.discussionId);
}

/** Narrow, non-fetching title projection for every strip; message/read-state updates retain its identity. */
export function useDiscussionTitleProjections(addresses: readonly Readonly<{
    serverId: string | null;
    discussionId: string;
}>[]): readonly (string | null)[] {
    const serverIds = React.useMemo(() => addresses.map(address => address.serverId), [addresses]);
    const bindings = useServerCredentialAccountScopeBindings(serverIds);
    const source = React.useMemo(() => {
        const entries = addresses.map(address => {
            const serverId = resolveServerProfileScopeIdForIdentifier(address.serverId);
            return { ...address, serverId, binding: bindings.get(serverId) };
        });
        let titles: readonly (string | null)[] = [];
        const read = () => {
            const next = entries.map(entry => {
                if (!entry.binding?.isCurrent()) return null;
                const snapshot = readRegisteredDiscussionRepository(entry.binding.scope, entry)?.getSnapshot();
                return readDiscussionSnapshotTitle(snapshot, entry.discussionId);
            });
            if (next.length !== titles.length || next.some((title, index) => title !== titles[index])) titles = next;
            return titles;
        };
        return { read, subscribe: (listener: () => void) => {
            const subscribed = new Set<string>();
            const disposals: Array<() => void> = [];
            for (const entry of entries) {
                if (!entry.binding?.isCurrent()) continue;
                const key = JSON.stringify([entry.serverId, entry.binding.accountId]);
                if (subscribed.has(key)) continue;
                subscribed.add(key);
                disposals.push(subscribeRegisteredDiscussionRepository(entry.binding.scope, entry, listener));
                const retirement = entry.binding.onRetire(listener);
                disposals.push(() => retirement.dispose());
            }
            return () => { for (const dispose of disposals) dispose(); };
        } };
    }, [addresses, bindings]);
    return React.useSyncExternalStore(source.subscribe, source.read, source.read);
}
