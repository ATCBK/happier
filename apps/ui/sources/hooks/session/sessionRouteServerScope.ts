import { listSessionAddressesForSessionIdFromLocalState, type SessionAddressLookupQueryState, type SessionAddressLookupState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

type SessionRouteServerScopeParams = Readonly<Record<string, unknown>>;

type SessionRouteHrefQueryValue = string | readonly string[] | number | boolean | null | undefined;

type BuildScopedSessionRouteHrefParams = Readonly<{
    sessionId: string;
    serverId?: string | null;
    /** Exact committed server message; the message-detail route owns its resolution. */
    messageId?: string;
    suffix?: string;
    query?: Readonly<Record<string, SessionRouteHrefQueryValue>>;
}>;

export type SessionRouteServerScope = Readonly<{
    serverId: string | null;
    candidateAddresses: readonly SessionAddress[];
    hydrationOptions?: Readonly<{ serverId: string }>;
    withParams: <T extends Record<string, unknown>>(params: T) => T & { serverId?: string };
    buildHref: (sessionId: string, options?: Readonly<{
        suffix?: string;
        query?: Readonly<Record<string, SessionRouteHrefQueryValue>>;
    }>) => `/session/${string}`;
}>;

function normalizeRouteParam(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(value)) {
        return normalizeRouteParam(value[0]);
    }
    return null;
}

export function readSessionRouteServerId(params: SessionRouteServerScopeParams | null | undefined): string | null {
    if (!params) return null;
    const serverId = normalizeRouteParam(params.serverId);
    return serverId ? resolveServerProfileScopeIdForIdentifier(serverId) : null;
}

export function mergeSessionRouteServerScopeParams<T extends Record<string, unknown>>(
    params: T,
    serverId?: string | null,
): T & { serverId?: string } {
    const normalizedServerId = normalizeRouteParam(serverId);
    if (!normalizedServerId) {
        return params as T & { serverId?: string };
    }
    return {
        ...params,
        serverId: normalizedServerId,
    };
}

export function buildScopedSessionRouteHref(params: BuildScopedSessionRouteHrefParams): `/session/${string}` {
    const normalizedSessionId = String(params.sessionId ?? '').trim();
    const normalizedSuffix = params.messageId
        ? `/message/${encodeURIComponent(`server:${params.messageId}`)}`
        : typeof params.suffix === 'string' ? params.suffix : '';
    const pathname: `/session/${string}` = `/session/${encodeURIComponent(normalizedSessionId)}${normalizedSuffix}`;
    const searchParams = new URLSearchParams();
    const normalizedServerId = normalizeRouteParam(params.serverId);
    if (normalizedServerId) {
        searchParams.set('serverId', normalizedServerId);
    }

    for (const [key, rawValue] of Object.entries(params.query ?? {})) {
        if (key === 'serverId') continue;
        if (rawValue === null || rawValue === undefined) continue;
        if (Array.isArray(rawValue)) {
            for (const value of rawValue) searchParams.append(key, value);
            continue;
        }
        const value = String(rawValue);
        if (value.length === 0) continue;
        searchParams.set(key, value);
    }

    const query = searchParams.toString();
    return query.length > 0 ? `${pathname}?${query}` : pathname;
}

export function createSessionRouteServerScope(
    params: SessionRouteServerScopeParams | null | undefined,
    state?: SessionAddressLookupState | null,
    options?: Readonly<{
        queryStates?: readonly SessionAddressLookupQueryState[];
        homeServerIds?: readonly string[];
    }>,
): SessionRouteServerScope {
    const explicitServerId = readSessionRouteServerId(params);
    const sessionId = normalizeRouteParam(params?.id) ?? '';
    const candidateAddresses = explicitServerId ? [] : listSessionAddressesForSessionIdFromLocalState(
        state, sessionId, options,
    );
    // A fresh route has no Session membership yet. Its sole saved Home is
    // unambiguous; multiple saved Homes never let focus choose the target.
    const homeServerIds = [...new Set(options?.homeServerIds?.map(normalizeRouteParam).filter((id): id is string => id !== null))];
    const serverId = explicitServerId ?? (candidateAddresses.length === 1
        ? candidateAddresses[0].serverId
        : sessionId && candidateAddresses.length === 0 && homeServerIds.length === 1 ? homeServerIds[0] : null);

    return {
        serverId,
        candidateAddresses,
        hydrationOptions: serverId ? { serverId } : undefined,
        withParams: <T extends Record<string, unknown>>(nextParams: T) =>
            mergeSessionRouteServerScopeParams(nextParams, serverId),
        buildHref: (sessionId: string, options?: Readonly<{
            suffix?: string;
            query?: Readonly<Record<string, SessionRouteHrefQueryValue>>;
        }>) => buildScopedSessionRouteHref({
            sessionId,
            serverId,
            suffix: options?.suffix,
            query: options?.query,
        }),
    };
}
