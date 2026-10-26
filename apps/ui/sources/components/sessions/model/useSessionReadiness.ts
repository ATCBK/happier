import * as React from 'react';
import type { SessionReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiSessionStatusGet } from '@/sync/ops/actions/sessionStatusAction';
import { readSessionReadinessRepair } from './sessionReadinessViewModel';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { QualifiedConnectedAccountPurposeTeamResourceSelectionV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/** Opened Bot/People/picker detail only: the status owner assembles all facts, with explicit retry. */
export function useSessionReadiness(input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    sessionId: string;
    enabled: boolean;
    operation?: SessionReadinessV1['operation'];
    credentialPurpose?: QualifiedConnectedAccountPurposeV1;
    credentialTeamSelection?: QualifiedConnectedAccountPurposeTeamResourceSelectionV1;
}>) {
    const { accountLifetime, sessionId } = input;
    const operation = input.operation ?? 'conversation';
    const credentialPurposeKey = JSON.stringify(input.credentialPurpose ?? null);
    const credentialPurpose = React.useMemo(() => input.credentialPurpose, [credentialPurposeKey]);
    const credentialTeamSelectionKey = JSON.stringify(input.credentialTeamSelection ?? null);
    const credentialTeamSelection = React.useMemo(() => input.credentialTeamSelection, [credentialTeamSelectionKey]);
    const key = JSON.stringify([serverAccountScopeKeySuffix(accountLifetime.scope), sessionId, operation, credentialPurposeKey, credentialTeamSelectionKey]);
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
                sessionId, serverId: accountLifetime.scope.serverId, readiness: true, operation,
                ...(credentialPurpose ? { credentialPurpose } : {}), signal: controller.signal,
                ...(credentialTeamSelection ? { credentialTeamSelection } : {}),
            }));
            if (!current()) return;
            const requested = result.ok !== false && result.readiness?.operation === operation;
            setState({ key, readiness: requested ? result.readiness ?? null : null, loading: false,
                unavailableReason: result.ok === false ? result.code : requested ? null : 'unsupported' });
        } catch {
            if (current()) setState({ key, readiness: null, loading: false, unavailableReason: 'unavailable' });
        } finally {
            account?.dispose();
            if (request.current === controller) request.current = null;
        }
    }, [accountLifetime, enabled, key, sessionId, operation, credentialPurpose, credentialTeamSelection]);
    React.useEffect(() => {
        if (!enabled) return;
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, accountLifetime.scope.serverId)) return;
            if (event.changeKinds && !event.changeKinds.some(kind => kind === 'session' || kind === 'share')) return;
            if (event.entityIds && !event.entityIds.includes(sessionId)) return;
            // The wake supplies no authority. Reread this Session through the
            // same status owner so a changed grant cannot leave View-only copy
            // beside a composer that already accepts input.
            void read(false);
        });
        void read(false);
        return () => { unsubscribe(); request.current?.abort(); };
    }, [accountLifetime.scope.serverId, enabled, read, sessionId]);
    const refresh = React.useCallback(() => read(true), [read]);
    const readiness = enabled && state.key === key ? state.readiness : null;
    return React.useMemo(() => ({ readiness, repair: readiness ? readSessionReadinessRepair(readiness) : null,
        loading: enabled && state.key === key && state.loading,
        unavailableReason: enabled && state.key === key ? state.unavailableReason : null, refresh,
    }), [enabled, key, readiness, refresh, state]);
}
