import * as React from 'react';
import { AutonomousExchangeStatusV1Schema, readAutonomousExchangeAdmissionV1,
    type AutonomousExchangeControlRequestV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readSessionExchangeStatus } from '@/sync/api/session/sessionExchangeApi';
import { controlSessionExchange, type SessionExchangeObservation } from '@/sync/ops/sessions/sessionExchangeActions';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/** Mount for the selected original input. No root is guessed from a Session's latest message. */
export function useSessionExchangeControl(address: SessionAddress, originInputLocalId: string | null, enabled = true) {
    const serverIds = React.useMemo(() => enabled && originInputLocalId ? [address.serverId] : [], [address.serverId, enabled, originInputLocalId]);
    const bindings = useServerCredentialAccountScopeBindings(serverIds);
    const binding = [...bindings.values()][0] ?? null;
    const [observation, setObservation] = React.useState<SessionExchangeObservation | null>(null);
    const [refreshing, setRefreshing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [pending, setPending] = React.useState<AutonomousExchangeControlRequestV1['control'] | null>(null);
    const pendingRef = React.useRef(false);
    const request = React.useRef<AbortController | null>(null);
    const current = enabled && binding?.isCurrent() && observation?.accountId === binding.accountId
        && observation.address.serverId === address.serverId && observation.address.sessionId === address.sessionId
        && observation.originInputLocalId === originInputLocalId ? observation : null;
    const currentObservation = React.useRef(current);
    currentObservation.current = current;

    const refresh = React.useCallback(async () => {
        if (!enabled || !originInputLocalId || !binding?.isCurrent()) return;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setRefreshing(true);
        const retirement = binding.onRetire(() => controller.abort());
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        try {
            account = await captureLazyActionAccountContext(address.serverId, controller.signal);
            if (account.accountId !== binding.accountId || !binding.isCurrent()) return;
            const status = await readSessionExchangeStatus(account, address.sessionId, originInputLocalId, controller.signal);
            if (controller.signal.aborted || !binding.isCurrent()) return;
            setObservation({ address: { serverId: address.serverId, sessionId: address.sessionId }, accountId: binding.accountId, originInputLocalId, status });
            setError(null);
        } catch (failure) {
            if (!controller.signal.aborted && binding.isCurrent()) setError(failure instanceof Error ? failure.message : 'exchange_unavailable');
        } finally {
            retirement.dispose();
            account?.dispose();
            if (request.current === controller) { request.current = null; setRefreshing(false); }
        }
    }, [address.serverId, address.sessionId, binding, enabled, originInputLocalId]);

    React.useEffect(() => {
        void refresh();
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, address.serverId)) void refresh();
        });
        return () => { request.current?.abort(); unsubscribe(); };
    }, [address.serverId, refresh]);

    const control = React.useCallback(async (kind: AutonomousExchangeControlRequestV1['control']): Promise<ActionExecuteResult> => {
        if (!current || !binding?.isCurrent() || pendingRef.current) return { ok: false, errorCode: 'exchange_unavailable', error: 'Exchange unavailable' };
        pendingRef.current = true;
        setPending(kind);
        try {
            const result = await controlSessionExchange(current, kind);
            if (!binding.isCurrent() || currentObservation.current !== current) return result;
            const status = AutonomousExchangeStatusV1Schema.safeParse(result.ok ? result.result : null);
            if (status.success) { setObservation({ ...current, status: status.data }); setError(null); }
            else if (!result.ok) { setError(result.errorCode); if (result.errorCode === 'exchange_revision_conflict') void refresh(); }
            return result;
        } catch {
            if (binding.isCurrent() && currentObservation.current === current) setError('exchange_unavailable');
            return { ok: false, errorCode: 'exchange_unavailable', error: 'Exchange unavailable' };
        } finally { pendingRef.current = false; setPending(null); }
    }, [binding, current, refresh]);

    return { observation: current, admission: current ? readAutonomousExchangeAdmissionV1(current.status.state) : null,
        refreshing, error, pending, refresh, control };
}
