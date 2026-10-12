import * as React from 'react';
import { projectReachForMachinesV1, type ReachProjectionV1 } from '@happier-dev/protocol/reach/projectReachV1';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useReachRulesCatalog } from '@/sync/store/useReachRulesCatalog';

export type ReachMachineProjection = Readonly<ReachProjectionV1[number] & { offline: boolean }>;
const empty: readonly ReachMachineProjection[] = Object.freeze([]);

/** Cached inventory only: offline machines retain their installed-Agent facts. */
export function useReachProjection(kind: 'skill' | 'mcp_server', itemId: string, opts?: Readonly<{ projectKey?: string }>): readonly ReachMachineProjection[] {
    const catalog = useReachRulesCatalog(kind, itemId);
    const inventory = useAllProfileMachineInventorySnapshots();
    const scope = catalog.scope;
    const machines = React.useMemo(() => inventory.flatMap(row => row.kind === 'resolved' && scope
        && row.accountId === scope.accountId && areServerProfileIdentifiersEquivalent(row.profileId, scope.serverId)
        ? row.machines : []), [inventory, scope]);
    const machineIds = React.useMemo(() => machines.map(machine => machine.id), [machines]);
    const installed = useMachineAgentsByMachine({ serverId: scope?.serverId ?? '', machineIds, load: false });
    const presence = useMachinePresenceSummaries(scope?.serverId, machineIds);
    return React.useMemo(() => !scope || catalog.status !== 'ready' ? empty : projectReachForMachinesV1(catalog.rules, {
        projectKey: opts?.projectKey,
        machines: machines.map(machine => ({ machineId: machine.id,
            platform: machine.metadata?.platform === 'win32' ? 'win32' : machine.metadata?.platform ? 'posix' : null,
            agentIds: (installed.get(machine.id)?.agents ?? []).filter(agent => agent.installed).map(agent => agent.agentId),
        })),
    }).map((row, index) => ({ ...row, offline: presence[index]?.reachability === 'unreachable' })),
    [scope, catalog.status, catalog.rules, opts?.projectKey, machines, installed, presence]);
}
