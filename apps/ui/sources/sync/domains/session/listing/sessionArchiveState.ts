import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { SessionListViewItem } from './sessionListViewData';

export type SessionArchiveOperation = Readonly<{ serverId: string; sessionId: string }>;
export type SessionArchiveOperations = Readonly<Record<string, Readonly<Record<string, SessionArchiveOperation>>>>;

export function resolveSessionArchiveServerId(serverId?: string | null): string {
    return resolveServerProfileScopeIdForIdentifier(serverId ?? getActiveServerSnapshot().serverId);
}

export function readSessionArchivePending(
    state: Readonly<{ sessionArchiveOperations?: SessionArchiveOperations }>,
    sessionId: string,
    serverId: string,
): boolean {
    return state.sessionArchiveOperations?.[serverId]?.[sessionId] !== undefined;
}

/** Pending operations retain their row without modifying server-owned runtime or cached snapshots. */
export function projectSessionArchivesToListViewData(
    source: SessionListViewItem[] | null,
    operations: readonly SessionArchiveOperation[],
    activeServerId: string,
): SessionListViewItem[] | null {
    if (!source || operations.length === 0) return source;
    const pendingByServer = new Map<string, Set<string>>();
    for (const operation of operations) {
        let ids = pendingByServer.get(operation.serverId);
        if (!ids) pendingByServer.set(operation.serverId, ids = new Set());
        ids.add(operation.sessionId);
    }
    let changed = false;
    const projected = source.map((item) => {
        if (item.type !== 'session' || !pendingByServer.get(item.serverId ?? activeServerId)?.has(item.session.id)) return item;
        changed = true;
        return { ...item, session: { ...item.session, archiving: true, keepVisibleWhenInactive: true } };
    });
    return changed ? projected : source;
}
