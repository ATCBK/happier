import * as React from 'react';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { createUiClientActionReverseHandler } from '@/sync/ops/actions/clientActionReverseDispatch';
import { getMountedWorkflowDraftAddresses, subscribeMountedWorkflowDraftOwners } from '@/sync/ops/actions/workflowAuthoringAction';
import { workflowDraftClientRpcMethod } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import {
    currentUiContextCommandClientRpcMethod,
    currentUiContextReadClientRpcMethod,
    mountedWorkReadClientRpcMethod,
    sessionUiActionClientRpcMethod,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import { getMountedWorkReadAddresses, subscribeMountedWorkReadOwners } from '@/sync/ops/actions/mountedWorkReadAction';
import { createCurrentUiContributedActionRpcHandler } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';

function MachineClientActionBinding({ serverId, generation, accountId, machineId, method, sessionId, readCurrentSessionId }: Readonly<{
    serverId: string;
    generation: number;
    accountId: string;
    machineId: string;
    method: string;
    sessionId?: string;
    readCurrentSessionId?: () => string | null;
}>): null {
    React.useEffect(() => {
        let mounted = true;
        const binding = { serverId, accountId, isCurrent: () => {
            const active = getActiveServerSnapshot();
            const state = storage.getState();
            const machine = resolveServerScopedMachine(state, serverId, machineId);
            return active.serverId === serverId && active.generation === generation
                && state.profile?.id === accountId && Boolean(machine
                    && isMachineSelectableForFleet({ serverId, accountId }, machine));
        }, canExecute: () => mounted
            && (sessionId === undefined || readCurrentSessionId?.() === sessionId) };
        const handler = method === RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE
            ? createCurrentUiContributedActionRpcHandler({
                ...binding, machineId, readProjection: readCurrentAppShellPluginUiProjection,
                execute: async (...args) => {
                    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                    return await createDefaultActionExecutor().execute(...args);
                },
            })
            : createUiClientActionReverseHandler(binding);
        const dispose = apiSocket.registerMachineScopedRpcHandler(
            machineId, method, handler, { settleInFlight: true },
        );
        return () => {
            mounted = false;
            dispose();
        };
    }, [serverId, generation, accountId, machineId, method, sessionId, readCurrentSessionId]);
    return null;
}

/** Currently reachable Machines share the existing reconnect-safe reverse-RPC channel. */
export function ClientActionReverseRuntime(): React.ReactElement | null {
    const { serverId, generation } = useActiveServerSnapshot();
    const accountId = storage(state => state.profile?.id ?? null);
    const { selectableMachineIds } = useMachinePresenceMembership(serverId);
    const { pluginUiProjection } = useAppShellPluginUiProjection();
    const contributedMachineIds = new Set(Object.values(pluginUiProjection?.actionsById ?? {}).flatMap(action => {
        const origin = readPluginUiContributionOrigin(action);
        return action.execution.target === 'client' && origin?.phase === 'current' && origin.interactionEnabled
            && origin.serverId === serverId ? [origin.machineId] : [];
    }));
    const addresses = React.useSyncExternalStore(subscribeMountedWorkflowDraftOwners,
        getMountedWorkflowDraftAddresses, getMountedWorkflowDraftAddresses);
    const readAddresses = React.useSyncExternalStore(subscribeMountedWorkReadOwners,
        getMountedWorkReadAddresses, getMountedWorkReadAddresses);
    const currentUiReader = useOptionalCurrentUiContextReader();
    const subscribeCurrentUiRegistration = React.useCallback((listener: () => void) =>
        currentUiReader?.subscribe(listener) ?? (() => {}), [currentUiReader]);
    const readCurrentUiRegistration = React.useCallback(() => {
        const snapshot = currentUiReader?.readCurrentUiContext() ?? null;
        // The reader rebuilds its DTO on every call; only method membership is a stable store snapshot.
        return snapshot ? JSON.stringify([currentUiReader?.readCurrentSessionId?.() ?? null,
            snapshot.commands.map(command => command.id)]) : null;
    }, [currentUiReader]);
    React.useSyncExternalStore(
        subscribeCurrentUiRegistration,
        readCurrentUiRegistration,
        readCurrentUiRegistration,
    );
    const currentUiSnapshot = currentUiReader?.readCurrentUiContext() ?? null;
    const currentSessionId = currentUiReader?.readCurrentSessionId?.() ?? null;
    if (!serverId || !accountId) return null;
    // Inventory changes retire only the removed Machine, not unrelated in-flight Actions.
    const methods = [...new Set([RPC_METHODS.UI_ACTION_EXECUTE, ...addresses.flatMap(address =>
        address.scope.serverId === serverId && address.scope.accountId === accountId
            ? [workflowDraftClientRpcMethod(address), workflowDraftClientRpcMethod({ scope: address.scope })] : []),
        ...readAddresses.flatMap(address => address.scope.serverId === serverId && address.scope.accountId === accountId
            ? [mountedWorkReadClientRpcMethod(address.actionId, address.sessionId)] : []),
        ...(currentUiSnapshot ? [currentUiContextReadClientRpcMethod(), ...currentUiSnapshot.commands.map(command =>
            currentUiContextCommandClientRpcMethod(command.id))] : []),
    ])];
    const sessionMethod = currentSessionId ? sessionUiActionClientRpcMethod(currentSessionId) : null;
    return <>{selectableMachineIds.flatMap(machineId => [...methods,
        ...(sessionMethod ? [sessionMethod] : []),
        ...(contributedMachineIds.has(machineId) ? [RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE] : []),
    ].map(method => <MachineClientActionBinding key={`${machineId}:${method}`}
        serverId={serverId} generation={generation} accountId={accountId} machineId={machineId} method={method}
        {...(method === sessionMethod && currentSessionId ? { sessionId: currentSessionId,
            readCurrentSessionId: currentUiReader?.readCurrentSessionId } : {})} />))}</>;
}
