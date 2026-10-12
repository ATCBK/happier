import type { Machine } from '@/sync/domains/state/storageTypes';

import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';

function compareMachinesForPicker(a: Machine, b: Machine): number {
    if (a.active !== b.active) return a.active ? 1 : -1;
    const aActiveAt = typeof a.activeAt === 'number' ? a.activeAt : 0;
    const bActiveAt = typeof b.activeAt === 'number' ? b.activeAt : 0;
    if (aActiveAt !== bActiveAt) return aActiveAt - bActiveAt;
    const aUpdatedAt = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
    const bUpdatedAt = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
    if (aUpdatedAt !== bUpdatedAt) return aUpdatedAt - bUpdatedAt;
    const aCreatedAt = typeof a.createdAt === 'number' ? a.createdAt : 0;
    const bCreatedAt = typeof b.createdAt === 'number' ? b.createdAt : 0;
    return aCreatedAt - bCreatedAt;
}

export function resolveMachineActionCandidates(
    scope: MachineReachabilityScope | null | undefined,
    allMachines: readonly Machine[],
    options: Readonly<{ onlineOnly?: boolean; nowMs?: number }> = {},
): Machine[] {
    const onlineOnly = options.onlineOnly ?? true;
    const nowMs = options.nowMs ?? Date.now();
    const bestById = new Map<string, Machine>();

    for (const machine of allMachines) {
        if (onlineOnly && !isMachineSelectableForFleet(scope, machine, nowMs)) continue;

        // Display names are not identity: distinct registrations remain separately selectable.
        const existing = bestById.get(machine.id);
        if (!existing) {
            bestById.set(machine.id, machine);
            continue;
        }
        if (compareMachinesForPicker(machine, existing) > 0) {
            bestById.set(machine.id, machine);
        }
    }

    // The Machines that can work lead, as on the Machines page; inside each presence group the order is the
    // name, so a heartbeat never reshuffles a list (an open picker also keeps the order it opened with).
    const online = new Map([...bestById.values()].map(machine => [machine.id, isMachineSelectableForFleet(scope, machine, nowMs)]));
    return [...bestById.values()]
        .sort((a, b) => {
            const presenceCmp = Number(online.get(b.id)) - Number(online.get(a.id));
            if (presenceCmp !== 0) return presenceCmp;
            const aLabel = readMachineName(a) ?? a.id;
            const bLabel = readMachineName(b) ?? b.id;
            const labelCmp = aLabel.localeCompare(bLabel);
            if (labelCmp !== 0) return labelCmp;
            return a.id.localeCompare(b.id);
        });
}
