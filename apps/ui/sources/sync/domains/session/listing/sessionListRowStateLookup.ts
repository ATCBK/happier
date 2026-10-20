import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '../../server/serverProfiles';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import type { SessionListRenderableSession } from './sessionListRenderable';

export type SessionListRowStateByServerId =
    Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;

/** Canonical Home entries win; a retained legacy entry is a fallback, never a second Home. */
export function resolveSessionListHomeKey<T>(
    valuesByServerId: Readonly<Record<string, T>> | null | undefined,
    serverIdRaw: string | null | undefined,
): string | null {
    const requested = normalizeTrimmedString(serverIdRaw);
    if (!valuesByServerId || !requested) return null;
    const canonical = resolveServerProfileScopeIdForIdentifier(requested);
    if (valuesByServerId[canonical] !== undefined) return canonical;
    if (valuesByServerId[requested] !== undefined) return requested;
    return Object.keys(valuesByServerId).find(candidate => areServerProfileIdentifiersEquivalent(candidate, canonical)) ?? null;
}

export function readSessionListRowsForServerId(
    rowsByServerId: SessionListRowStateByServerId | null | undefined,
    serverIdRaw: string | null | undefined,
): Readonly<Record<string, SessionListRenderableSession>> | null {
    const key = resolveSessionListHomeKey(rowsByServerId, serverIdRaw);
    if (!key || !rowsByServerId) return null;
    return rowsByServerId[key] ?? null;
}

export function readSessionListRowForServerId(
    rowsByServerId: SessionListRowStateByServerId | null | undefined,
    serverIdRaw: string | null | undefined,
    sessionIdRaw: string | null | undefined,
): SessionListRenderableSession | null {
    const sessionId = normalizeTrimmedString(sessionIdRaw);
    if (!sessionId) return null;
    return readSessionListRowsForServerId(rowsByServerId, serverIdRaw)?.[sessionId] ?? null;
}
