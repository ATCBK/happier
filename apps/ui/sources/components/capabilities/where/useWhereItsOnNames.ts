import * as React from 'react';

import {
  useAgentCatalogIdentities,
  type SessionAgentCatalogIdentity,
} from '@/agents/registry/useSessionAgentCatalogIdentity';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

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
  const identities = useAgentCatalogIdentities({
    agentIds: input.agentIds,
    machineId: input.machineId ?? null,
    serverId: input.serverId ?? null,
  });
  const identityById = React.useMemo(
    () => new Map(identities.map((identity) => [identity.entry.agentId, identity])),
    [identities],
  );
  const names = React.useMemo<WhereItsOnNames>(() => {
    const machines = new Map(input.machines.map((machine) => [machine.machineId, machine.name]));
    const projects = new Map(input.projects.map((project) => [project.projectKey, project.name]));
    const machineName = (machineId: string) => machines.get(machineId) ?? machineId;
    return {
      agentName: (agentId) => identityById.get(agentId)?.entry.title ?? agentId,
      machineName,
      projectName: (projectKey) => projects.get(projectKey) ?? projectKey,
      folderLabel: (machineId, root) => `${formatPathRelativeToHome(root)} · ${machineName(machineId)}`,
    };
  }, [input.machines, input.projects, identityById]);
  return { names, identityById };
}
