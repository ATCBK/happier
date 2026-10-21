import * as React from 'react';
import { Platform } from 'react-native';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';

import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { markSessionOpenRequestedForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { useAuth } from '@/auth/context/AuthContext';
import { buildScopedSessionRouteHref } from './sessionRouteServerScope';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';

type NavigateToSessionOptions = Readonly<{
    serverId?: string;
    /** Exact committed server message, resolved by the existing message-detail route. */
    messageId?: string;
    query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}>;

/** The hook and interaction-only callers share the same Home switch and destination owner. */
export async function navigateToSession(sessionId: string, opts: NavigateToSessionOptions | undefined, owner: Readonly<{
    router: Pick<ReturnType<typeof useDestinationRouter>, 'navigate'>;
    refreshFromActiveServer: () => Promise<void>;
}>): Promise<void> {
    /**
     * `query` is the same scoped-href query the route already understands
     * (`jumpSeq`, and the session pane's `details`/`path`/`sha`/`right` state).
     * It travels through THIS owner rather than a caller-built href so a deep
     * result — a transcript match, a workspace file, a commit — still gets the
     * Home switch, the telemetry mark and the singular-session navigation that
     * every other session open gets.
     */
    const explicitServerId = String(opts?.serverId ?? '').trim();
    const normalizedSessionId = normalizeSessionId(sessionId);
    const targetServerId = explicitServerId || String(resolvePreferredServerIdForSessionId(normalizedSessionId) ?? '').trim();
    markSessionOpenRequestedForSessionUiTelemetry({
        sessionId: normalizedSessionId,
        source: 'navigate-hook',
    });
    // A bare Session id only justifies a Home *switch* when the canonical local-state
    // resolver proves exactly one Home; switching on 0 or >1 candidates would let
    // active-Home focus silently choose a different Session. The unqualified route is
    // the existing owner of that unresolved case — it presents the Which Home? chooser
    // for several candidates and asks which saved Home to open it on for none (never
    // the focused Home, Lane 07.1) — so the tap still leads somewhere instead of dying
    // silently.
    if (targetServerId) {
        void setActiveServerAndSwitch({
            serverId: targetServerId,
            scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
            refreshAuth: owner.refreshFromActiveServer,
        }).catch(() => {
            // If switching fails, still try navigation so users can recover in-session.
        });
    }

    owner.router.navigate(buildScopedSessionRouteHref({
        sessionId: normalizedSessionId,
        serverId: targetServerId || null,
        ...(opts?.messageId ? { suffix: `/message/${encodeURIComponent(`server:${opts.messageId}`)}` } : {}),
        ...(opts?.query ? { query: opts.query } : {}),
    }), {
        dangerouslySingular(name, params) {
            return 'session';
        },
    });
}

export function useNavigateToSession() {
    const router = useDestinationRouter();
    const auth = useAuth();
    return React.useCallback((sessionId: string, opts?: NavigateToSessionOptions) => navigateToSession(sessionId, opts, {
        router, refreshFromActiveServer: auth.refreshFromActiveServer,
    }), [auth.refreshFromActiveServer, router]);
}
