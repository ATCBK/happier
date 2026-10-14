import * as React from 'react';

import {
  useAgentCatalogIdentities,
  type SessionAgentCatalogIdentity,
} from '@/agents/registry/useSessionAgentCatalogIdentity';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { joinList } from '@/utils/text/joinList';

import type { WhereItsOnNames } from './whereItsOnPresentation';

/**
 * The names "Where it's on" words use: Agents from the catalog identity owner, machines and projects
 * from the caller's places. One builder for the control's sentence and the lists' short summaries.
 */
export function useWhereItsOnNames(input: Readonly<{
  agentIds: readonly string[];
  machines: readonly Readonly<{ machineId: string; name: string }>[];
  projects: readonly Readonly<{ projectKey: string; name: string }>[];
  machineId?: string | null;
  serverId?: string | null;
}>): Readonly<{ names: WhereItsOnNames; identityById: ReadonlyMap<string, SessionAgentCatalogIdentity> }> {
  const machines = React.useMemo(() => input.machines.map(machine => ({ machineId: machine.machineId, agentIds: input.agentIds })), [input.machines, input.agentIds]);
  const identities = useAgentCatalogIdentities({
    agentIds: input.agentIds,
    machineId: input.machineId ?? null,
    serverId: input.serverId ?? null,
    machines,
  });
  const identityById = React.useMemo(() => {
    const result = new Map<string, SessionAgentCatalogIdentity>();
    const byRuntimeId = new Map<string, SessionAgentCatalogIdentity[]>();
    for (const identity of identities) {
      result.set(identity.entry.backendTargetKey ?? identity.entry.qualifiedId, identity);
      const group = byRuntimeId.get(identity.entry.agentId) ?? [];
      group.push(identity);
      byRuntimeId.set(identity.entry.agentId, group);
    }
    // A runtime-wide rule may use an instance mark only when that identity is unambiguous.
    for (const [agentId, group] of byRuntimeId) if (group.length === 1) result.set(agentId, group[0]!);
    return result;
  }, [identities]);
  const names = React.useMemo<WhereItsOnNames>(() => {
    const machines = new Map(input.machines.map((machine) => [machine.machineId, machine.name]));
    const projects = new Map(input.projects.map((project) => [project.projectKey, project.name]));
    const machineName = (machineId: string) => machines.get(machineId) ?? machineId;
    return {
      agentName: (agentId) => joinList(identities.filter(identity => identity.entry.agentId === agentId)
        .map(identity => identity.entry.title)) || agentId,
      machineName,
      projectName: (projectKey) => projects.get(projectKey) ?? projectKey,
      folderLabel: (machineId, root) => `${formatPathRelativeToHome(root)} · ${machineName(machineId)}`,
    };
  }, [input.machines, input.projects, identities]);
  return { names, identityById };
}
