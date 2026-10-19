import type { MachineResourceAutomaticActionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import { readMachinePublishedResources, type MachineAttentionSubject } from '@/components/machines/summary/machineResourceSentences';
import type { ActiveSelectionMachineGroup } from '@/components/settings/machines/hooks/useActiveSelectionMachineGroups';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';

/** One machine of the open surface with what it publishes: its attention and the guard's last act. */
export type MachineAttentionEntry = MachineAttentionSubject & Readonly<{
    key: string;
    serverId: string;
    machineId: string;
    online: boolean;
    lastAutomaticAction: MachineResourceAutomaticActionV1 | null;
}>;

/**
 * The open surface's machines with their published attention (plan 20's `daemonState.resources`, read
 * through its schema): every online machine that reports, named as the lists name it. `reportingCount`
 * is how many publish anything at all — zero keeps every sentence away.
 */
export function collectMachineAttention(groups: readonly ActiveSelectionMachineGroup[], nowMs: number = Date.now()): Readonly<{
    entries: readonly MachineAttentionEntry[];
    reportingCount: number;
    onlineCount: number;
    reportingMachineKeys: readonly string[];
}> {
    const entries: MachineAttentionEntry[] = [];
    const reportingMachineKeys: string[] = [];
    let onlineCount = 0;
    for (const group of groups) {
        const names = resolveMachineDisplayNames(group.machines);
        for (const machine of group.machines) {
            if (!isMachineVisibleForLaunchSelection(machine) || machine.availability?.kind === 'locked'
                || (machine.access && machine.access.accessState !== 'ready')) continue;
            const online = isMachineReachable(group.accountScope, machine, nowMs);
            if (online) onlineCount += 1;
            const published = online ? readMachinePublishedResources(machine.daemonState) : null;
            if (!published) continue;
            if (published.vitals.state === 'reporting') reportingMachineKeys.push(JSON.stringify([group.serverId, machine.id]));
            entries.push({
                key: JSON.stringify([group.serverId, machine.id]),
                serverId: group.serverId,
                machineId: machine.id,
                name: names.get(machine.id) ?? machine.id,
                online,
                attention: published.attention,
                lastAutomaticAction: published.lastAutomaticAction ?? null,
            });
        }
    }
    return { entries, reportingCount: entries.length, onlineCount, reportingMachineKeys };
}
