import * as React from 'react';
import type { SessionReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiSessionStatusGet } from '@/sync/ops/actions/sessionStatusAction';
import { readSessionReadinessRepair } from './sessionReadinessViewModel';

/** Opened Bot/People/picker detail only: the status owner assembles all facts, with explicit retry. */
export function useSessionReadiness(input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    sessionId: string;
    enabled: boolean;
}>) {
    const { accountLifetime, sessionId } = input;
    const key = JSON.stringify([serverAccountScopeKeySuffix(accountLifetime.scope), sessionId]);
    const [state, setState] = React.useState<Readonly<{
        key: string; readiness: SessionReadinessV1 | null; loading: boolean; unavailableReason: string | null;
    }>>({ key, readiness: null, loading: false, unavailableReason: null });
    const request = React.useRef<AbortController | null>(null);
    const subscribe = React.useCallback((notify: () => void) => {
        if (!input.enabled) return () => {};
        const retirement = accountLifetime.onRetire(notify);
        return () => retirement.dispose();
    }, [accountLifetime, input.enabled]);
    const readCurrent = React.useCallback(() => input.enabled && accountLifetime.isCurrent(), [accountLifetime, input.enabled]);
    const enabled = React.useSyncExternalStore(subscribe, readCurrent, readCurrent) && Boolean(sessionId.trim());
    const read = React.useCallback(async (force: boolean) => {
        if (!enabled || !accountLifetime.isCurrent()) return;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        const current = () => !controller.signal.aborted && accountLifetime.isCurrent();
        setState(previous => ({ key, readiness: previous.key === key ? previous.readiness : null,
            loading: true, unavailableReason: null }));
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
        try {
            account = await captureLazyActionAccountContext(accountLifetime.scope.serverId, controller.signal);
            if (!current()) return;
            if (!areServerAccountScopesEqual(account.accountLifetime.scope, accountLifetime.scope)) {
                throw new Error('action_account_scope_changed');
            }
            const result = SessionStatusActionResultV1Schema.parse(await createUiSessionStatusGet(account, { refreshReadiness: force })({
                sessionId, serverId: accountLifetime.scope.serverId, readiness: true, signal: controller.signal,
            }));
            if (!current()) return;
            setState({ key, readiness: result.ok === false ? null : result.readiness ?? null, loading: false,
                unavailableReason: result.ok === false ? result.code : null });
        } catch {
            if (current()) setState({ key, readiness: null, loading: false, unavailableReason: 'unavailable' });
        } finally {
            account?.dispose();
            if (request.current === controller) request.current = null;
        }
    }, [accountLifetime, enabled, key, sessionId]);
    React.useEffect(() => {
        if (enabled) void read(false);
        return () => { request.current?.abort(); };
    }, [enabled, read]);
    const refresh = React.useCallback(() => read(true), [read]);
    const readiness = enabled && state.key === key ? state.readiness : null;
    return React.useMemo(() => ({ readiness, repair: readiness ? readSessionReadinessRepair(readiness) : null,
        loading: enabled && state.key === key && state.loading,
        unavailableReason: enabled && state.key === key ? state.unavailableReason : null, refresh,
    }), [enabled, key, readiness, refresh, state]);
}
