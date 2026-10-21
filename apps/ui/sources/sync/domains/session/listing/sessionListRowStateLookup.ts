import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier, type ProfileScopeResolver } from '../../server/serverProfiles';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import type { SessionListRenderableSession } from './sessionListRenderable';

export type SessionListRowStateByServerId =
    Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;

/** Canonical Home entries win; a retained legacy entry is a fallback, never a second Home. */
export function resolveSessionListHomeKey<T>(
    valuesByServerId: Readonly<Record<string, T>> | null | undefined,
    serverIdRaw: string | null | undefined,
    resolveScopeId?: ProfileScopeResolver,
): string | null {
    const requested = normalizeTrimmedString(serverIdRaw);
    if (!valuesByServerId || !requested) return null;
    const canonical = (resolveScopeId ?? resolveServerProfileScopeIdForIdentifier)(requested);
    if (valuesByServerId[canonical] !== undefined) return canonical;
    if (valuesByServerId[requested] !== undefined) return requested;
    return Object.keys(valuesByServerId).find(candidate => areServerProfileIdentifiersEquivalent(candidate, canonical, resolveScopeId)) ?? null;
}

export function readSessionListRowsForServerId(
    rowsByServerId: SessionListRowStateByServerId | null | undefined,
    serverIdRaw: string | null | undefined,
    resolveScopeId?: ProfileScopeResolver,
): Readonly<Record<string, SessionListRenderableSession>> | null {
    const key = resolveSessionListHomeKey(rowsByServerId, serverIdRaw, resolveScopeId);
    if (!key || !rowsByServerId) return null;
    return rowsByServerId[key] ?? null;
}

export function readSessionListRowForServerId(
    rowsByServerId: SessionListRowStateByServerId | null | undefined,
    serverIdRaw: string | null | undefined,
    sessionIdRaw: string | null | undefined,
    resolveScopeId?: ProfileScopeResolver,
): SessionListRenderableSession | null {
    const sessionId = normalizeTrimmedString(sessionIdRaw);
    if (!sessionId) return null;
    return readSessionListRowsForServerId(rowsByServerId, serverIdRaw, resolveScopeId)?.[sessionId] ?? null;
}
