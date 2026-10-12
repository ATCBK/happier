import type { ReachPlaceV1 } from '@happier-dev/protocol';
import { resolveCreateReachV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';

import type { Machine } from '@/sync/domains/state/storageTypes';

/**
 * Creates the initial persisted MCP binding target. The binding itself remains
 * the feature-owned routing decision for later MCP operations; this draft
 * default is not a Machine Administration execution target.
 */
export function createDefaultMcpBindingTarget(_machines: readonly Pick<Machine, 'id'>[]): ReachPlaceV1 {
    const reach = resolveCreateReachV1({ kind: 'mcp_server', caller: { surface: 'ui' },
        ctx: { nowMs: 0, newId: () => 'draft' } });
    if (!reach.ok) throw new Error(reach.code);
    return reach.rules[0]!.target;
}

export function resolveMcpBindingTargetTypeChange(
    currentTarget: ReachPlaceV1,
    nextType: ReachPlaceV1['t'],
    machines: readonly Pick<Machine, 'id'>[],
    selectedMachineId?: string,
): ReachPlaceV1 | null {
    if (nextType === 'allMachines') {
        return { t: 'allMachines' };
    }
    if (nextType === 'project') return currentTarget.t === 'project' ? currentTarget : null;

    const machineId = currentTarget.t === 'allMachines' || currentTarget.t === 'project'
        ? selectedMachineId
        : currentTarget.machineId;
    if (!machineId) {
        return null;
    }
    if (currentTarget.t === 'allMachines' && !machines.some((machine) => machine.id === machineId)) {
        return null;
    }

    if (nextType === 'machine') {
        return { t: 'machine', machineId };
    }

    return { t: 'workspace', machineId, workspaceRoot: '/' };
}
