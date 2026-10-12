import type { AgentExecutionTargetV1, BackendTargetRefV2 } from '@happier-dev/protocol';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import {
  indexAgentRoutingIdsByContributionIdentity,
  readAgentRoutingIdForContributionIdentity,
} from '@/plugins/projection/registry/agentRoutingIdentity';

/** Preserve an admitted selection in the existing host routing reference. */
export function projectResolvedAgentBackendTarget(agentTarget: AgentExecutionTargetV1, agentId: string): BackendTargetRefV2 {
  return {
    kind: 'backend',
    backendId: agentId,
    ...(agentTarget.definitionId !== undefined ? { configuredBackendId: agentTarget.definitionId } : {}),
    sourceKind: 'built_in',
  };
}

/** Canonical installed-Agent projection shared by every authored Session creator. */
export function resolveSessionCreationAgentTarget(agentTarget: AgentExecutionTargetV1): Readonly<{
  agentId: string;
  backendTarget: BackendTargetRefV2;
}> | null {
  const selectedTarget = AgentExecutionTargetV1Schema.safeParse(agentTarget);
  if (!selectedTarget.success) return null;
  const catalog = readAgentCatalogSnapshot();
  const agentId = readAgentRoutingIdForContributionIdentity(
    indexAgentRoutingIdsByContributionIdentity([...catalog.agentDefinitionsById.values()]),
    selectedTarget.data.identity,
  );
  const agentContribution = agentId ? catalog.agentDefinitionsById.get(agentId) : null;
  if (!agentContribution) return null;

  return {
    agentId: agentContribution.id,
    backendTarget: projectResolvedAgentBackendTarget(selectedTarget.data, agentContribution.id),
  };
}
