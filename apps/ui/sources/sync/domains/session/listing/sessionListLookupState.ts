import type { SessionListRenderableSession } from './sessionListRenderable';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import { getActiveServerSnapshot } from '../../server/serverRuntime';
import { resolveSessionMachineId } from '../external/resolveSessionMachineId';
import { normalizeSessionAddress, type SessionAddress } from '../sessionAddress';
import {
    resolveSessionAddressFromLocalState,
    resolveServerIdForSessionIdFromLocalState,
    type SessionAddressLookupState,
} from '../resolveSessionAddressFromLocalState';
import { readSessionListRowForServerId, type SessionListRowStateByServerId } from './sessionListRowStateLookup';
import type { SessionListIndexItem } from '../../sessionList/sessionListIndex';
import type { ConcurrentSessionListCacheByServerId } from './concurrentSessionListCache';

export type SessionServerLookupStateLike = (Omit<
    SessionAddressLookupState,
    'sessions' | 'sessionListIndexByServerId' | 'sessionListRowsByServerId'
> & Readonly<{
    sessions?: Readonly<Record<string, { serverId?: unknown; metadata?: unknown } | null>> | null;
    /**
     * The list index and row maps are read here as the canonical store owns them
     * (`sync/store/types.ts`); the address-lookup base only needs `serverId`, so it
     * declares them loosely.
     */
    sessionListIndexByServerId?: Readonly<Record<string, readonly SessionListIndexItem[] | null | undefined>> | null;
    sessionListRowsByServerId?: SessionListRowStateByServerId | null;
    concurrentSessionListCacheByServerId?: ConcurrentSessionListCacheByServerId | null;
}>) | null | undefined;
export type SessionListLookupStateLike = SessionServerLookupStateLike;

export type SessionMetadataLike = Readonly<{
    summary?: Readonly<{ text?: unknown }> | null;
    summaryText?: unknown;
    name?: unknown;
    path?: unknown;
    host?: unknown;
    homeDir?: unknown;
    machineId?: unknown;
    permissionMode?: unknown;
    externalSessionV1?: unknown;
}> | null | undefined;

export type SessionListLookupSessionServerScope = Readonly<{
    serverId: string | null;
    serverName: string | null;
}>;

export type SessionListLookupSessionEntry = Readonly<{
    serverId: string;
    serverName: string | null;
    session: SessionListRenderableSession;
}>;

const EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSIONS: SessionListLookupSessionEntry[] = [];
const EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSION_IDS: string[] = [];

/** String input is the legacy boundary; it delegates all ambiguity decisions to one owner. */
function resolveLookupAddress(
    state: SessionServerLookupStateLike,
    target: SessionAddress | string,
): SessionAddress | null {
    return typeof target === 'string'
        ? resolveSessionAddressFromLocalState(state, target)
        : normalizeSessionAddress(target.serverId, target.sessionId);
}

export function resolveSessionListLookupSessionServerScopeFromState(
    state: SessionServerLookupStateLike,
    target: SessionAddress | string,
): SessionListLookupSessionServerScope | null {
    const address = resolveLookupAddress(state, target);
    if (!address) return null;
    const item = state?.sessionListIndexByServerId?.[address.serverId]?.find(
        (candidate) => candidate.type === 'session' && candidate.sessionId === address.sessionId,
    );
    return {
        serverId: address.serverId,
        serverName: normalizeTrimmedString(item?.serverName)
            || normalizeTrimmedString(state?.concurrentSessionListCacheByServerId?.[address.serverId]?.serverName)
            || null,
    };
}

export function findSessionListLookupSession(
    state: SessionListLookupStateLike,
    target: SessionAddress | string,
    _options?: Readonly<{ activeServerId?: string | null }>,
): SessionListLookupSessionEntry | null {
    const address = resolveLookupAddress(state, target);
    if (!address) return null;
    const scopedRow = readSessionListRowForServerId(
        state?.sessionListRowsByServerId,
        address.serverId,
        address.sessionId,
    );
    if (!scopedRow) return null;
    return {
        serverId: address.serverId,
        serverName: resolveSessionListLookupSessionServerScopeFromState(state, address)?.serverName ?? null,
        session: scopedRow,
    };
}

export function listSessionListLookupActiveSessions(
    state: SessionListLookupStateLike,
    options?: Readonly<{ activeServerId?: string | null }>,
): SessionListLookupSessionEntry[] {
    const serverId = normalizeTrimmedString(options?.activeServerId) || getActiveServerSnapshot().serverId;
    const membership = state?.ordinarySessionListMembershipByServerId?.[serverId];
    if (!membership?.length) return EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSIONS;
    const out: SessionListLookupSessionEntry[] = [];
    for (const sessionId of membership) {
        const address = normalizeSessionAddress(serverId, sessionId);
        if (!address) continue;
        const entry = findSessionListLookupSession(state, address, { activeServerId: serverId });
        if (entry) out.push(entry);
    }
    return out.length ? out : EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSIONS;
}

export function listSessionListLookupActiveSessionIds(
    state: SessionListLookupStateLike,
    limit?: number,
): string[] {
    const membership = state?.ordinarySessionListMembershipByServerId?.[getActiveServerSnapshot().serverId];
    if (!membership?.length || limit === 0) return EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSION_IDS;
    const ids: string[] = [];
    for (const member of membership) {
        const sessionId = normalizeTrimmedString(member);
        if (!sessionId) continue;
        ids.push(sessionId);
        if (typeof limit === 'number' && limit > 0 && ids.length >= limit) break;
    }
    return ids.length ? ids : EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSION_IDS;
}

export function listSessionListLookupServerSessions(
    state: SessionListLookupStateLike,
): SessionListLookupSessionEntry[] {
    let entries: SessionListLookupSessionEntry[] | null = null;
    for (const [serverIdRaw, membership] of Object.entries(state?.ordinarySessionListMembershipByServerId ?? {})) {
        const serverId = normalizeTrimmedString(serverIdRaw);
        if (!serverId || !membership?.length) continue;
        const serverName = normalizeTrimmedString(state?.concurrentSessionListCacheByServerId?.[serverId]?.serverName)
            || null;
        for (const member of membership) {
            const sessionId = normalizeTrimmedString(member);
            const session = sessionId ? state?.sessionListRowsByServerId?.[serverId]?.[sessionId] : null;
            if (!session) continue;
            entries ??= [];
            entries.push({ serverId, serverName, session });
        }
    }
    return entries ?? EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSIONS;
}

export function listSessionListLookupServers(
    state: SessionListLookupStateLike,
): SessionListLookupSessionServerScope[] {
    let entries: SessionListLookupSessionServerScope[] | null = null;
    for (const [serverIdRaw, membership] of Object.entries(state?.ordinarySessionListMembershipByServerId ?? {})) {
        const serverId = normalizeTrimmedString(serverIdRaw);
        if (!serverId || !membership?.some((sessionId) => Boolean(state?.sessionListRowsByServerId?.[serverId]?.[sessionId]))) {
            continue;
        }
        entries ??= [];
        entries.push({
            serverId,
            serverName: normalizeTrimmedString(state?.concurrentSessionListCacheByServerId?.[serverId]?.serverName) || null,
        });
    }
    return entries ?? EMPTY_SESSION_LIST_LOOKUP_ACTIVE_SESSIONS;
}

export function resolveSessionListLookupSessionServerId(
    state: SessionListLookupStateLike,
    target: SessionAddress | string,
): string | null {
    return resolveLookupAddress(state, target)?.serverId ?? null;
}

export function resolveSessionListPreferredServerIdFromState(
    state: SessionServerLookupStateLike,
    sessionId: string,
    _fallbackServerId?: string | null,
): string | null {
    // Historical callers passed focus as a fallback. It cannot establish a Session's origin.
    return resolveServerIdForSessionIdFromLocalState(state, sessionId);
}

export function resolveSessionListPreferredSessionMetadataFromState(
    state: SessionServerLookupStateLike,
    target: SessionAddress | string,
    options?: Readonly<{ activeServerId?: string | null }>,
): SessionMetadataLike {
    const address = resolveLookupAddress(state, target);
    if (!address) return null;
    const directSession = state?.sessions?.[address.sessionId];
    const directMetadataValue = directSession?.metadata && typeof directSession.metadata === 'object'
        ? directSession.metadata as SessionMetadataLike
        : null;
    const directServerId = directMetadataValue
        ? normalizeTrimmedString(directSession?.serverId)
            || normalizeTrimmedString(options?.activeServerId)
            || getActiveServerSnapshot().serverId
        : null;
    const directMetadata = directServerId === address.serverId ? directMetadataValue : null;
    // Metadata needs the keyed row, not the labeled entry's presentation-index scan.
    const cachedMetadata = readSessionListRowForServerId(
        state?.sessionListRowsByServerId, address.serverId, address.sessionId,
    )?.metadata;
    if (!cachedMetadata) return directMetadata;
    if (resolveSessionMachineId(cachedMetadata)) return cachedMetadata;
    const machineId = resolveSessionMachineId(directMetadata);
    return machineId ? { ...cachedMetadata, machineId } : cachedMetadata;
}
