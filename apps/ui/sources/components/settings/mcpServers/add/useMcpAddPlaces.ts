import * as React from 'react';
import { agentReceivesUserMcpServersV1 } from '@happier-dev/protocol/plugins/contributions/v2';

import { getAgentCore } from '@/agents/catalog/catalog';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

/** Machines, their names and which Agents take user MCP servers (IR-80): what Where it's on offers in the Add modal. */
export function useMcpAddPlaces() {
  const scope = useAccountSettingsScope();
  const { machines } = useReachMachines();
  const placeMachines = React.useMemo(
    () =>
      machines.map((machine) => ({
        machineId: machine.machineId,
        name: machine.name ?? machine.machineId,
        online: machine.online,
      })),
    [machines],
  );
  const agentIds = React.useMemo(
    () => [...new Set(machines.flatMap((machine) => machine.agentIds))],
    [machines],
  );
  const { names, projects, workspaceRefs } = useWhereItsOnNames({
    agentIds,
    machines: placeMachines,
    serverId: scope?.serverId ?? null,
  });
  const agentTakes = React.useCallback(
    (agentId: string): 'full' | 'none' =>
      agentReceivesUserMcpServersV1(getAgentCore(agentId)?.tools.delivery)
        ? 'full'
        : 'none',
    [],
  );
  return React.useMemo(
    () => ({ machines, placeMachines, projects, workspaceRefs, agentIds, names, agentTakes }),
    [machines, placeMachines, projects, workspaceRefs, agentIds, names, agentTakes],
  );
}

export type McpAddPlaces = ReturnType<typeof useMcpAddPlaces>;
