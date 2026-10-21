import * as React from 'react';
import type { AgentId } from '@happier-dev/agents';
import { useMachineAgentsByMachine } from './useMachineAgents';

/** Hub badges are a cache-only installed-fact projection, not another CLI probe owner. */
export function useDetectedAgentsByMachine(serverId: string, machineIds: readonly string[], agentIds?: readonly string[]): Map<string, { agentIds: AgentId[]; readAt: number }> {
    const snapshots = useMachineAgentsByMachine({ serverId, machineIds, load: false });
    return React.useMemo(() => new Map([...snapshots].map(([machineId, snapshot]) => [machineId, {
        agentIds: snapshot.agents.filter((agent) => agent.installed && (!agentIds || agentIds.includes(agent.agentId))).map((agent) => agent.agentId),
        readAt: snapshot.lastCheckedAt ?? 0,
    }])), [agentIds, snapshots]);
}
