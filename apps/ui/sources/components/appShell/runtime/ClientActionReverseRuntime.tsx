import * as React from 'react';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage, useAllMachines } from '@/sync/domains/state/storage';
import { createUiClientActionReverseHandler } from '@/sync/ops/actions/clientActionReverseDispatch';
import { getMountedWorkflowDraftAddresses, subscribeMountedWorkflowDraftOwners } from '@/sync/ops/actions/workflowAuthoringAction';
import { workflowDraftClientRpcMethod } from '@happier-dev/protocol/actions/workflowAuthoringAction';

function MachineClientActionBinding({ serverId, generation, accountId, machineId, method }: Readonly<{
    serverId: string;
    generation: number;
    accountId: string;
    machineId: string;
    method: string;
}>): null {
    React.useEffect(() => {
        let mounted = true;
        const handler = createUiClientActionReverseHandler({ serverId, accountId, isCurrent: () => {
            const active = getActiveServerSnapshot();
            return mounted && active.serverId === serverId && active.generation === generation
                && storage.getState().profile?.id === accountId;
        } });
        const dispose = apiSocket.registerMachineScopedRpcHandler(
            machineId, method, handler,
        );
        return () => {
            mounted = false;
            dispose();
        };
    }, [serverId, generation, accountId, machineId, method]);
    return null;
}

/** Account-visible Machines share the existing reconnect-safe reverse-RPC channel. */
export function ClientActionReverseRuntime(): React.ReactElement | null {
    const { serverId, generation } = useActiveServerSnapshot();
    const accountId = storage(state => state.profile?.id ?? null);
    const machines = useAllMachines();
    const addresses = React.useSyncExternalStore(subscribeMountedWorkflowDraftOwners,
        getMountedWorkflowDraftAddresses, getMountedWorkflowDraftAddresses);
    if (!serverId || !accountId) return null;
    // Inventory changes retire only the removed Machine, not unrelated in-flight Actions.
    const methods = [...new Set([RPC_METHODS.UI_ACTION_EXECUTE, ...addresses.flatMap(address =>
        address.scope.serverId === serverId && address.scope.accountId === accountId
            ? [workflowDraftClientRpcMethod(address), workflowDraftClientRpcMethod({ scope: address.scope })] : [])])];
    return <>{machines.flatMap(machine => methods.map(method => <MachineClientActionBinding key={`${machine.id}:${method}`}
        serverId={serverId} generation={generation} accountId={accountId} machineId={machine.id} method={method} />))}</>;
}
