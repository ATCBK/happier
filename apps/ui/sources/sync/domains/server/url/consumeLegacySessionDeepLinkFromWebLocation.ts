import { buildScopedSessionRouteHref, readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';

type LegacySessionDeepLink = Readonly<{
    route: ReturnType<typeof buildScopedSessionRouteHref>;
    cleanedRelativeUrl: string;
}>;

/** Both native/local Root params and the historical web URL use this one route decision. */
export function resolveLegacySessionDeepLinkRoute(params: Readonly<{
    sessionId: string | null;
    serverId?: unknown;
    messageId?: string | null;
    jumpChildId?: string | null;
}>): ReturnType<typeof buildScopedSessionRouteHref> | null {
    const sessionId = normalizeSessionId(params.sessionId);
    if (!sessionId) return null;
    const messageId = String(params.messageId ?? '').trim();
    const jumpChildId = String(params.jumpChildId ?? '').trim();
    return buildScopedSessionRouteHref({
        sessionId, serverId: readSessionRouteServerId(params),
        suffix: messageId ? `/message/${encodeURIComponent(messageId)}` : '',
        query: jumpChildId ? { jumpChildId } : undefined,
    });
}

type ConsumeLegacySessionDeepLinkFromWebLocationOptions = Readonly<{
    isAuthenticated: boolean;
    navigateToRoute: (route: ReturnType<typeof buildScopedSessionRouteHref>) => void;
    replaceRelativeUrl: (nextRelativeUrl: string) => void;
}>;

function readLegacySessionDeepLinkFromWebLocation(): LegacySessionDeepLink | null {
    if (typeof window === 'undefined') return null;
    if (typeof window.location?.href !== 'string') return null;

    try {
        const current = new URL(window.location.href);
        // Legacy deep-link format: `/?id=<sessionId>` (no longer generated, but may be in old links or buggy flows).
        if (current.pathname !== '/') return null;

        const route = resolveLegacySessionDeepLinkRoute({
            sessionId: current.searchParams.get('id'),
            serverId: current.searchParams.get('serverId'),
            messageId: current.searchParams.get('messageId'),
            jumpChildId: current.searchParams.get('jumpChildId'),
        });
        if (!route) return null;

        current.searchParams.delete('id');
        const search = current.searchParams.toString();
        const cleanedRelativeUrl = `${current.pathname}${search ? `?${search}` : ''}${current.hash ?? ''}`;
        return { route, cleanedRelativeUrl };
    } catch {
        return null;
    }
}

export function consumeLegacySessionDeepLinkFromWebLocation(
    options: ConsumeLegacySessionDeepLinkFromWebLocationOptions,
): boolean {
    if (!options.isAuthenticated) return false;

    const legacy = readLegacySessionDeepLinkFromWebLocation();
    if (!legacy) return false;

    options.replaceRelativeUrl(legacy.cleanedRelativeUrl);
    options.navigateToRoute(legacy.route);
    return true;
}
