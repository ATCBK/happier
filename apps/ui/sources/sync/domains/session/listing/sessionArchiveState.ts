import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListRowStateByServerId } from './sessionListRowStateLookup';
import { captureServerProfileScopeResolver, resolveServerProfileScopeIdForIdentifier, type ProfileScopeResolver } from '../../server/serverProfiles';
import { normalizeSessionAddress, type SessionAddress } from '../sessionAddress';

export type SessionArchiveOperation = Readonly<SessionAddress>;
export type SessionArchiveOperations = Readonly<Record<string, Readonly<Record<string, SessionArchiveOperation>>>>;

export function resolveSessionArchiveAddress(address: SessionAddress): SessionAddress | null {
    return normalizeSessionAddress(resolveServerProfileScopeIdForIdentifier(address.serverId), address.sessionId);
}

/** Only the exact admitted object may borrow an existing Session's archive operation. */
export function isSessionArchiveOperationCurrent(
    state: Readonly<{ sessionArchiveOperations?: SessionArchiveOperations }>,
    operation: SessionArchiveOperation,
    address: SessionAddress = operation,
): boolean {
    if (state.sessionArchiveOperations?.[operation.serverId]?.[operation.sessionId] !== operation) return false;
    const target = resolveSessionArchiveAddress(address);
    const captured = resolveSessionArchiveAddress(operation);
    return target !== null && captured !== null
        && target.serverId === captured.serverId && target.sessionId === captured.sessionId;
}

export function readSessionArchivePending(
    state: Readonly<{ sessionArchiveOperations?: SessionArchiveOperations }>,
    address: SessionAddress,
    resolveScopeId: ProfileScopeResolver = resolveServerProfileScopeIdForIdentifier,
): boolean {
    const operations = state.sessionArchiveOperations;
    if (operations?.[address.serverId]?.[address.sessionId]) return true;
    const serverId = resolveScopeId(address.serverId);
    // Discovery can promote a Home identity after admission. Keep the operation
    // and its captured key unchanged so only its own completion can settle it.
    return Object.entries(operations ?? {}).some(([capturedServerId, bucket]) => (
        bucket[address.sessionId] !== undefined
        && resolveScopeId(capturedServerId) === serverId
    ));
}

export function readSessionArchiveOperationsForServers(
    state: Readonly<{ sessionArchiveOperations?: SessionArchiveOperations }>,
    serverIds?: readonly string[] | null,
    resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver(),
): SessionArchiveOperation[] {
    const selected = serverIds ? new Set(serverIds.map(resolveScopeId)) : null;
    return Object.entries(state.sessionArchiveOperations ?? {}).flatMap(([serverId, bucket]) => (
        !selected || selected.has(resolveScopeId(serverId)) ? Object.values(bucket) : []
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
    const resolveScopeId = captureServerProfileScopeResolver();
    let result: Record<string, Rows> | null = null;
    for (const [serverId, rows] of Object.entries(source)) {
        const canonicalId = resolveScopeId(serverId);
        const pending = operations.filter(operation => resolveScopeId(operation.serverId) === canonicalId
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
