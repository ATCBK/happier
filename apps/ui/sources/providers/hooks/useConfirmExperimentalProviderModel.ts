import * as React from 'react';
import type { ProviderErrorV1 } from '@happier-dev/protocol';

import type {
    SessionModelPickerExperimentalConfirmation,
    SessionModelPickerExperimentalConfirmationController,
} from '@/components/sessions/modelPicker/SessionModelPicker';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { providerErrorRequestsRetry } from '@/providers/connection/recovery';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function useConfirmExperimentalProviderModel(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    agentTargetKey: string | null;
    refresh: () => Promise<unknown>;
}>): SessionModelPickerExperimentalConfirmationController {
    const { mutateProviderModelSettings, pendingApproval } = useProviderActionClient(input.serverId);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const scopeKey = JSON.stringify([
        input.enabled,
        input.machineId,
        input.serverId,
        input.agentTargetKey,
    ]);
    const invocationLifetime = React.useMemo(() => ({ controller: new AbortController() }), [accountLifetime, scopeKey]);
    const activeScopeKey = React.useRef(scopeKey);
    const activeAccountLifetime = React.useRef(accountLifetime);
    const mounted = React.useRef(false);
    const pendingAttemptId = React.useRef(0);
    const [pending, setPending] = React.useState<Readonly<{ modelName: string }> | null>(null);
    const [failure, setFailure] = React.useState<
        | Readonly<{
            error: ProviderErrorV1;
            retryAttempt: Readonly<{
                confirmation: SessionModelPickerExperimentalConfirmation;
                commitSelection: () => void;
            }>;
        }>
        | Readonly<{
            error: ProviderErrorV1;
            retryAttempt?: undefined;
        }>
        | null
    >(null);
    activeScopeKey.current = scopeKey;
    activeAccountLifetime.current = accountLifetime;
    React.useEffect(() => {
        if (invocationLifetime.controller.signal.aborted) invocationLifetime.controller = new AbortController();
        const controller = invocationLifetime.controller;
        mounted.current = true;
        pendingAttemptId.current += 1;
        setPending(null);
        setFailure(null);
        const registration = accountLifetime?.onRetire(() => {
            controller.abort();
            pendingAttemptId.current += 1;
            setPending(null);
            setFailure(null);
        });
        return () => {
            controller.abort();
            mounted.current = false;
            registration?.dispose();
        };
    }, [accountLifetime, invocationLifetime, scopeKey]);

    const persist = React.useCallback(async (
        confirmation: SessionModelPickerExperimentalConfirmation,
        commitSelection: () => void,
    ): Promise<boolean> => {
        if (
            !input.enabled
            || !input.agentTargetKey
            || confirmation.agentTargetKey !== input.agentTargetKey
        ) return false;
        const requestScopeKey = scopeKey;
        const requestAccountLifetime = accountLifetime;
        const isCurrentScope = () => (
            mounted.current
            && activeScopeKey.current === requestScopeKey
            && activeAccountLifetime.current === requestAccountLifetime
            && (requestAccountLifetime?.isCurrent() ?? true)
        );
        if (!isCurrentScope()) return false;
        let result: Awaited<ReturnType<typeof mutateProviderModelSettings>>;
        try {
            result = await mutateProviderModelSettings({
                serverId: input.serverId,
                request: {
                    action: 'confirmExperimental',
                    ...(input.machineId ? { machineId: input.machineId } : {}),
                    connectionId: confirmation.connectionId,
                    ...(confirmation.connectedAccountTarget ? { connectedAccountTarget: confirmation.connectedAccountTarget } : {}),
                    expectedConnectionRevision: confirmation.expectedConnectionRevision,
                    agentTargetKey: confirmation.agentTargetKey,
                    modelId: confirmation.modelId,
                    compatibilityFingerprint: confirmation.compatibilityFingerprint,
                },
            }, { retainInvocationSignal: invocationLifetime.controller.signal });
        } catch (caught) {
            if (!isCurrentScope()) return false;
            const error = providerErrorFromRpcFailure(caught, {
                connectionId: confirmation.connectionId,
                ...(input.machineId ? { machineId: input.machineId } : {}),
            });
            if (error.code === 'provider_rpc_mutation_outcome_unknown') {
                try {
                    await input.refresh();
                } catch {
                    // The attempted confirmation may already be committed. Keep
                    // review-only recovery even when reconciliation cannot load.
                }
                if (!isCurrentScope()) return false;
            }
            setFailure(providerErrorRequestsRetry(error)
                ? { error, retryAttempt: { confirmation, commitSelection } }
                : { error });
            return false;
        }
        if (!isCurrentScope()) return false;
        if (result.status === 'error') {
            setFailure(providerErrorRequestsRetry(result.error)
                ? { error: result.error, retryAttempt: { confirmation, commitSelection } }
                : { error: result.error });
            return false;
        }
        setFailure(null);
        // The writer published the confirmed Account record. Revalidation of
        // model presentation must not block the requested selection.
        fireAndForget(input.refresh());
        if (!isCurrentScope()) return false;
        commitSelection();
        return true;
    }, [accountLifetime, invocationLifetime, mutateProviderModelSettings, input.agentTargetKey, input.enabled, input.machineId, input.refresh, input.serverId, scopeKey]);

    const runPending = React.useCallback(async (
        confirmation: SessionModelPickerExperimentalConfirmation,
        operation: () => Promise<boolean>,
    ): Promise<boolean> => {
        const attemptId = pendingAttemptId.current + 1;
        pendingAttemptId.current = attemptId;
        setPending({ modelName: confirmation.modelName });
        try {
            return await operation();
        } finally {
            if (pendingAttemptId.current === attemptId) {
                setPending(null);
            }
        }
    }, []);

    const confirm = React.useCallback(async (
        confirmation: SessionModelPickerExperimentalConfirmation,
        commitSelection: () => void,
    ): Promise<boolean> => {
        if (!input.enabled || !input.agentTargetKey || confirmation.agentTargetKey !== input.agentTargetKey) return false;
        return await runPending(confirmation, async () => {
            setFailure(null);
            // The Action's configurable approval default owns Ask first. A
            // second modal would ignore a waiver and ask twice otherwise.
            return await persist(confirmation, commitSelection);
        });
    }, [input.agentTargetKey, input.enabled, persist, runPending]);
    const retry = React.useCallback(async (): Promise<boolean> => {
        if (!input.enabled || !failure?.retryAttempt) return false;
        return await runPending(failure.retryAttempt.confirmation, () => persist(
            failure.retryAttempt.confirmation,
            failure.retryAttempt.commitSelection,
        ));
    }, [failure, input.enabled, persist, runPending]);
    const clear = React.useCallback(() => setFailure(null), []);

    return React.useMemo(() => ({
        confirm,
        pending: input.enabled && pending !== null,
        pendingModelName: input.enabled ? pending?.modelName ?? null : null,
        pendingApproval: input.enabled ? pendingApproval : null,
        error: input.enabled ? failure?.error ?? null : null,
        retry: input.enabled && failure?.retryAttempt ? retry : null,
        clear,
    }), [clear, confirm, failure, input.enabled, pending, pendingApproval, retry]);
}
