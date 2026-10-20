import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListRowStateByServerId } from './sessionListRowStateLookup';
import { resolveServerProfileScopeIdForIdentifier } from '../../server/serverProfiles';
import { normalizeSessionAddress, type SessionAddress } from '../sessionAddress';

export type SessionArchiveOperation = Readonly<SessionAddress>;
export type SessionArchiveOperations = Readonly<Record<string, Readonly<Record<string, SessionArchiveOperation>>>>;

export function resolveSessionArchiveAddress(address: SessionAddress): SessionAddress | null {
    return normalizeSessionAddress(resolveServerProfileScopeIdForIdentifier(address.serverId), address.sessionId);
}

export function readSessionArchivePending(
    state: Readonly<{ sessionArchiveOperations?: SessionArchiveOperations }>,
    address: SessionAddress,
): boolean {
    const operations = state.sessionArchiveOperations;
    if (operations?.[address.serverId]?.[address.sessionId]) return true;
    const serverId = resolveServerProfileScopeIdForIdentifier(address.serverId);
    // Discovery can promote a Home identity after admission. Keep the operation
    // and its captured key unchanged so only its own completion can settle it.
    return Object.entries(operations ?? {}).some(([capturedServerId, bucket]) => (
        bucket[address.sessionId] !== undefined
        && resolveServerProfileScopeIdForIdentifier(capturedServerId) === serverId
    ));
}

export function readSessionArchiveOperationsForServers(
    state: Readonly<{ sessionArchiveOperations?: SessionArchiveOperations }>,
    serverIds?: readonly string[] | null,
): SessionArchiveOperation[] {
    const selected = serverIds ? new Set(serverIds.map(resolveServerProfileScopeIdForIdentifier)) : null;
    return Object.entries(state.sessionArchiveOperations ?? {}).flatMap(([serverId, bucket]) => (
        !selected || selected.has(resolveServerProfileScopeIdForIdentifier(serverId)) ? Object.values(bucket) : []
    ));
}

// Keep unchanged pending projections stable across unrelated store writes.
const pendingRows = new WeakMap<SessionListRenderableSession, SessionListRenderableSession>();
export function projectSessionArchiveRow(
    row: SessionListRenderableSession | null,
    pending: boolean,
): SessionListRenderableSession | null {
    if (!row || !pending) return row;
    let projected = pendingRows.get(row);
    if (!projected) {
        projected = { ...row, archiving: true, keepVisibleWhenInactive: true };
        pendingRows.set(row, projected);
    }
    return projected;
}

type Rows = Readonly<Record<string, SessionListRenderableSession>>;
const pendingRowBuckets = new WeakMap<Rows, Readonly<{ operations: readonly SessionArchiveOperation[]; rows: Rows }>>();
export function projectSessionArchiveRowsByServerId(
    source: SessionListRowStateByServerId,
    operations: readonly SessionArchiveOperation[],
): SessionListRowStateByServerId {
    if (operations.length === 0) return source;
    let result: Record<string, Rows> | null = null;
    for (const [serverId, rows] of Object.entries(source)) {
        const canonicalId = resolveServerProfileScopeIdForIdentifier(serverId);
        const pending = operations.filter(operation => resolveServerProfileScopeIdForIdentifier(operation.serverId) === canonicalId
            && rows[operation.sessionId] !== undefined);
        if (pending.length === 0) continue;
        const cached = pendingRowBuckets.get(rows);
        let projected = cached?.operations.length === pending.length
            && cached.operations.every((operation, index) => operation === pending[index]) ? cached.rows : null;
        if (!projected) {
            const next = { ...rows };
            for (const operation of pending) next[operation.sessionId] = projectSessionArchiveRow(rows[operation.sessionId], true)!;
            projected = next;
            pendingRowBuckets.set(rows, { operations: pending, rows: projected });
        }
        result ??= { ...source };
        result[serverId] = projected;
    }
    return result ?? source;
}
