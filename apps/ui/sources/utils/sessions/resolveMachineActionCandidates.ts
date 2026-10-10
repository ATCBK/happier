import type { Machine } from '@/sync/domains/state/storageTypes';

import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

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
    allMachines: readonly Machine[],
    options: Readonly<{ onlineOnly?: boolean; nowMs?: number }> = {},
): Machine[] {
    const onlineOnly = options.onlineOnly ?? true;
    const nowMs = options.nowMs ?? Date.now();
    const bestById = new Map<string, Machine>();

    for (const machine of allMachines) {
        if (onlineOnly && !isMachineOnline(machine, nowMs)) continue;

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

    return [...bestById.values()]
        .sort((a, b) => {
            const aLabel = readMachineName(a) ?? a.id;
            const bLabel = readMachineName(b) ?? b.id;
            const labelCmp = aLabel.localeCompare(bLabel);
            if (labelCmp !== 0) return labelCmp;
            return a.id.localeCompare(b.id);
        });
}
