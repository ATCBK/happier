import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';

import type {
    SessionModelPickerExperimentalConfirmation,
    SessionModelPickerExperimentalConfirmationController,
} from '@/components/sessions/modelPicker/SessionModelPicker';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { providerErrorRequestsRetry } from '@/providers/connection/recovery';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

type ConfirmationRequest = SessionModelPickerExperimentalConfirmation | Readonly<{
    kind: 'team-model';
    model: TeamCredentialProviderModelCatalogEntryV1;
}>;

export function useConfirmExperimentalProviderModel(input: Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    agentTargetKey: string | null;
    refresh: () => Promise<unknown>;
}>): Omit<SessionModelPickerExperimentalConfirmationController, 'confirm'> & Readonly<{
    confirm: (request: ConfirmationRequest, commitSelection: () => void) => Promise<boolean>;
}> {
    const { describeProviderModels, mutateProviderModelSettings, pendingApproval } = useProviderActionClient(input.serverId);
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
                confirmation: ConfirmationRequest;
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

    const isCurrentScope = React.useCallback(() => mounted.current
        && activeScopeKey.current === scopeKey
        && activeAccountLifetime.current === accountLifetime
        && (accountLifetime?.isCurrent() ?? true), [accountLifetime, scopeKey]);

    const persist = React.useCallback(async (
        confirmation: SessionModelPickerExperimentalConfirmation,
        commitSelection: () => void,
        retryAttempt: Readonly<{ confirmation: ConfirmationRequest; commitSelection: () => void }> = { confirmation, commitSelection },
    ): Promise<boolean> => {
        if (
            !input.enabled
            || !input.agentTargetKey
            || confirmation.agentTargetKey !== input.agentTargetKey
        ) return false;
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
                    ...(confirmation.catalogSourceKey ? { catalogSourceKey: confirmation.catalogSourceKey } : {}),
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
                ? { error, retryAttempt }
                : { error });
            return false;
        }
        if (!isCurrentScope()) return false;
        if (result.status === 'error') {
            setFailure(providerErrorRequestsRetry(result.error)
                ? { error: result.error, retryAttempt }
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
    }, [isCurrentScope, invocationLifetime, mutateProviderModelSettings, input.agentTargetKey, input.enabled, input.machineId, input.refresh, input.serverId]);

    const runPending = React.useCallback(async (
        confirmation: Readonly<{ modelName: string }>,
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
        confirmation: ConfirmationRequest,
        commitSelection: () => void,
    ): Promise<boolean> => {
        const agentTargetKey = confirmation.kind === 'team-model' ? confirmation.model.selection.agentTargetKey : confirmation.agentTargetKey;
        if (!input.enabled || !input.agentTargetKey || agentTargetKey !== input.agentTargetKey || !isCurrentScope()) return false;
        const modelName = confirmation.kind === 'team-model'
            ? confirmation.model.descriptor.name || confirmation.model.selection.modelId
            : confirmation.modelName;
        return await runPending({ modelName }, async () => {
            setFailure(null);
            // The Action's configurable approval default owns Ask first. A
            // second modal would ignore a waiver and ask twice otherwise.
            if (confirmation.kind === 'confirm-experimental') return await persist(confirmation, commitSelection);
            const machineId = input.machineId;
            if (!machineId) {
                setFailure({ error: createProviderErrorV1('provider_machine_unavailable') });
                return false;
            }
            const fail = (error: ProviderErrorV1) => setFailure(providerErrorRequestsRetry(error)
                ? { error, retryAttempt: { confirmation, commitSelection } } : { error });
            try {
                // Home rows offer source facts. Only the selected worker's
                // admitted adapter can decide compatibility and recipient consent.
                const read = async () => {
                    const result = await describeProviderModels({ serverId: input.serverId, machineId,
                        agentTargetKey, teamCredentialModel: confirmation.model, refreshPolicy: 'current_only',
                    }, { signal: invocationLifetime.controller.signal });
                    if (!isCurrentScope()) return null;
                    if (result.status === 'error') { fail(result.error); return null; }
                    const entry = result.groups.flatMap(group => group.rows.map(row => ({ group, row }))).find(({ row }) => (
                        row.ref.agentTargetKey === agentTargetKey && row.ref.modelId === confirmation.model.selection.modelId
                    ));
                    if (!entry?.row.confirmationSource) { fail(createProviderErrorV1('provider_catalog_unavailable')); return null; }
                    if (!entry.group.authorization.authorized) { fail(entry.group.authorization.error); return null; }
                    if (entry.row.compatibility.result.status === 'incompatible') {
                        fail(createProviderErrorV1('provider_incompatible_with_agent')); return null;
                    }
                    return { ...entry, confirmationSource: entry.row.confirmationSource };
                };
                let entry = await read();
                if (!entry) return false;
                const { row } = entry;
                if (row.compatibility.result.status === 'experimental' && !row.compatibility.confirmed) {
                    const saved = await persist({ kind: 'confirm-experimental', ...entry.confirmationSource,
                        expectedConnectionRevision: entry.group.connectionRevision, agentTargetKey,
                        modelId: row.compatibility.result.confirmationScope.kind === 'model' ? row.ref.modelId : null,
                        compatibilityFingerprint: row.compatibility.compatibilityFingerprint,
                        providerName: entry.group.providerName, modelName: row.descriptor.name || row.ref.modelId,
                    }, () => {}, { confirmation, commitSelection });
                    if (!saved || !isCurrentScope()) return false;
                    entry = await read();
                    if (!entry) return false;
                    if (entry.row.compatibility.result.status === 'experimental' && !entry.row.compatibility.confirmed) {
                        fail(createProviderErrorV1('provider_compatibility_unverified')); return false;
                    }
                }
                commitSelection();
                return true;
            } catch (caught) {
                if (isCurrentScope()) fail(providerErrorFromRpcFailure(caught, { machineId }));
                return false;
            }
        });
    }, [describeProviderModels, input.agentTargetKey, input.enabled, input.machineId, input.serverId,
        invocationLifetime, isCurrentScope, persist, runPending]);
    const retry = React.useCallback(async (): Promise<boolean> => {
        if (!input.enabled || !failure?.retryAttempt) return false;
        return await confirm(failure.retryAttempt.confirmation, failure.retryAttempt.commitSelection);
    }, [confirm, failure, input.enabled]);
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
