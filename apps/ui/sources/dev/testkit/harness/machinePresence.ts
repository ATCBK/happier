import {
    captureMachinePresenceObservation,
    type MachineReachabilityScope,
} from '@/sync/domains/machines/reachability/machineReachability';
import type { Machine } from '@/sync/domains/state/storageTypes';

/** A fresh fixture ingress after publishing its rows; reconnect alone is not an observation. */
export function observeMachinePresenceForTest(scope: MachineReachabilityScope, machineIds: readonly string[]): void {
    captureMachinePresenceObservation(scope)(machineIds);
}

/** Publish the addressed Home inventory before observing its fresh presence ingress. */
export async function publishMachineInventoryForTest(scope: MachineReachabilityScope, machines: readonly Machine[]): Promise<void> {
    // Call after installing Home boundaries; importing this helper must not load Sync.
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.setState(state => ({
        machineListByServerId: { ...state.machineListByServerId, [scope.serverId]: [...machines] },
        machineListStatusByServerId: { ...state.machineListStatusByServerId, [scope.serverId]: 'idle' },
    }));
    observeMachinePresenceForTest(scope, machines.map(machine => machine.id));
}
