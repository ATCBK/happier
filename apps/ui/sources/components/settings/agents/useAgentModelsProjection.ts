import * as React from 'react';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';

import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';

type Projection = Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }>;

/** Machine observations enrich saved models; they never withdraw Account rows or visibility. */
function augmentAccountModels(account: Projection, machine: Projection | null, connectionIds: readonly string[]): Projection {
    if (!machine) return account;
    const admittedConnections = new Set(connectionIds);
    const machineGroups = new Map(machine.groups.map(group => [group.connectionId, group]));
    const accountConnectionIds = new Set(account.groups.map(group => group.connectionId));
    return {
        ...machine,
        ...account,
        groups: [
            ...account.groups.map(group => {
                const observed = machineGroups.get(group.connectionId);
                if (!observed || observed.connectionRevision !== group.connectionRevision) return group;
                const observedRows = new Map(observed.rows.map(row => [sessionModelSelectionKey(row.ref), row]));
                const accountRowKeys = new Set(group.rows.map(row => sessionModelSelectionKey(row.ref)));
                return {
                    ...observed,
                    ...group,
                    authorization: observed.authorization,
                    modelLoadAction: observed.modelLoadAction,
                    rows: [
                        ...group.rows.map(row => {
                            const facts = observedRows.get(sessionModelSelectionKey(row.ref));
                            return facts ? {
                                ...facts,
                                ...row,
                                descriptor: { ...facts.descriptor, ...row.descriptor },
                                compatibility: facts.compatibility,
                                endpointHealth: facts.endpointHealth,
                                catalog: facts.catalog,
                                loadState: facts.loadState,
                                sources: {
                                    manual: row.sources.manual || facts.sources.manual,
                                    static: row.sources.static || facts.sources.static,
                                    probe: row.sources.probe || facts.sources.probe,
                                },
                            } : row;
                        }),
                        ...observed.rows.filter(row => row.sources.probe && !row.sources.manual && !row.sources.static
                            && !accountRowKeys.has(sessionModelSelectionKey(row.ref))),
                    ],
                };
            }),
            ...machine.groups.filter(group => admittedConnections.has(group.connectionId) && !accountConnectionIds.has(group.connectionId)),
        ],
    };
}

export function useAgentModelsProjection(input: Readonly<{
    enabled: boolean;
    active?: boolean;
    machineId: string | null;
    serverId: string | null;
    agentTargetKey: string;
    connectionIds: readonly string[];
}>) {
    const account = useProviderModelProjection({ ...input, machineId: null, mode: 'management' });
    const machine = useProviderModelProjection({ ...input, enabled: input.enabled && input.machineId !== null, mode: 'management' });
    const data = React.useMemo(() => account.data ? augmentAccountModels(account.data, machine.data, input.connectionIds)
        // A live admitted plugin can supply Agent requirements absent from the bundled declarations.
        : account.error?.code === 'provider_agent_runtime_unsupported' && machine.data
            ? { ...machine.data, groups: machine.data.groups.filter(group => input.connectionIds.includes(group.connectionId)) }
            : null, [account.data, account.error, input.connectionIds, machine.data]);
    const refresh = React.useCallback(async () => {
        // Account edits settle independently of optional machine transport.
        void machine.refresh();
        await account.refresh();
    }, [account.refresh, machine.refresh]);
    const refreshWithResult = React.useCallback(async () => {
        const [accountResult, machineResult] = await Promise.all([account.refreshWithResult(), machine.refreshWithResult()]);
        // Load reconciliation is a real machine operation and needs that machine's result.
        return input.machineId ? machineResult : accountResult;
    }, [account.refreshWithResult, input.machineId, machine.refreshWithResult]);
    const machineFallback = !account.data && account.error?.code === 'provider_agent_runtime_unsupported' && input.machineId !== null;
    const error = machineFallback ? machine.error : account.error ?? machine.error;
    return { data, error, loading: machineFallback ? machine.loading : account.loading,
        refreshFailures: machine.refreshFailures, refresh, refreshWithResult };
}
