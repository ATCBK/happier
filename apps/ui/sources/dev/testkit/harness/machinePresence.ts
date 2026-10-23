import {
    captureMachinePresenceObservation,
    type MachineReachabilityScope,
} from '@/sync/domains/machines/reachability/machineReachability';

/** A fresh fixture ingress after publishing its rows; reconnect alone is not an observation. */
export function observeMachinePresenceForTest(scope: MachineReachabilityScope, machineIds: readonly string[]): void {
    captureMachinePresenceObservation(scope)(machineIds);
}
