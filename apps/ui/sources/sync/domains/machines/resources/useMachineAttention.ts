import * as React from 'react';

import { collectMachineAttention, readMachineAttentionInputs } from '@/components/machines/attention/collectMachineAttention';
import type { ActiveSelectionMachineGroup } from '@/components/settings/machines/hooks/useActiveSelectionMachineGroups';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveServerScopedMachines, selectMachineInventoryRowsById } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getStorage } from '@/sync/domains/state/storage';

type AttentionGroupTarget = Readonly<{
    serverId: string;
    accountScope: MachineReachabilityScope | null;
    machineIds: readonly string[];
}>;

/** Named attention for an open surface, with the same source facts as the closed summary. */
export function useMachineAttention(groups: readonly ActiveSelectionMachineGroup[]) {
    const language = usePreferredLanguage();
    const store = getStorage();
    // Membership and scope configure the subscription; new full-row/container
    // identities do not replace this source's mounted snapshot lifetime.
    const targetKey = JSON.stringify(groups.map(group => ({ serverId: group.serverId,
        accountScope: group.accountScope ? { serverId: group.accountScope.serverId, accountId: group.accountScope.accountId } : null,
        machineIds: group.machines.map(machine => machine.id),
    })));
    const groupTargets = React.useMemo(() => JSON.parse(targetKey) as AttentionGroupTarget[], [targetKey]);
    const readGroups = React.useCallback((): readonly ActiveSelectionMachineGroup[] => {
        const state = store.getState();
        const activeServerId = getActiveServerSnapshot().serverId;
        const resolveScopeId = captureServerProfileScopeResolver();
        return groupTargets.map(group => {
            const machines = resolveServerScopedMachines({ serverId: group.serverId, activeServerId,
                get activeMachines() { return Object.values(state.machines); },
                machineListByServerId: state.machineListByServerId,
                machineListStatusByServerId: state.machineListStatusByServerId,
            }, resolveScopeId);
            return { serverId: group.serverId, accountScope: group.accountScope, serverName: '', status: 'idle',
                machines: selectMachineInventoryRowsById(machines, group.machineIds).filter(machine => machine !== null) };
        });
    }, [groupTargets, store]);
    const readMachines = React.useCallback(() => readGroups().flatMap(group => group.machines), [readGroups]);
    const readSnapshot = React.useCallback((nowMs: number) => collectMachineAttention(readGroups(), nowMs), [readGroups, language]);
    const readDemandedInputs = React.useCallback((nowMs: number) => [language, ...readMachineAttentionInputs(readGroups(), nowMs)], [language, readGroups]);
    const targets = React.useMemo(() => groupTargets.map(group => ({ serverId: group.serverId, machineIds: group.machineIds })), [groupTargets]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets, undefined, readDemandedInputs);
}
