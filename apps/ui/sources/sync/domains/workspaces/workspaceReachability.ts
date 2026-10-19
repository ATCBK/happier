import { resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';

import type { WorkspaceScopeBase } from './workspaceScope';

type WorkspaceMachineInventoryState = Readonly<{
    machines?: Record<string, Machine | undefined>;
    machineListByServerId?: Record<string, Machine[] | null | undefined>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>;

/**
 * Resolves workspace reachability through the shared server-scoped machine
 * inventory and canonical machine-liveness policy. Machine ids are not global,
 * so a same-id machine on another Home can never make this scope reachable.
 */
export function isWorkspaceScopeReachableFromState(
    state: WorkspaceMachineInventoryState,
    scope: WorkspaceScopeBase,
    activeServerId: string,
    accountScope: ServerAccountScope | null,
): boolean {
    const inventory = resolveServerScopedMachineInventory<Machine>({
        serverId: scope.serverId,
        activeServerId,
        activeMachines: Object.values(state.machines ?? {}).filter((candidate): candidate is Machine => candidate !== undefined),
        machineListByServerId: state.machineListByServerId ?? {},
        machineListStatusByServerId: state.machineListStatusByServerId,
    });
    // A refresh retains live rows and their independently expiring presence.
    // Loading the inventory does not make a reachable daemon offline.
    if (inventory.status === 'error' || inventory.status === 'signedOut') return false;
    const machine = inventory.machines?.find(candidate => candidate.id === scope.machineId);
    return machine ? isMachineReachable(selectActiveServerAccountScopeForServer(accountScope, scope.serverId), machine) : false;
}

export function isWorkspaceScopeReachable(scope: WorkspaceScopeBase, accountScope: ServerAccountScope | null = getActiveServerAccountScope()): boolean {
    return isWorkspaceScopeReachableFromState(
        storage.getState(),
        scope,
        String(getActiveServerSnapshot().serverId ?? '').trim(),
        accountScope,
    );
}
