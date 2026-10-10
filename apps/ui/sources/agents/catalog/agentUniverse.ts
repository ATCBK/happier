import {
    getAllAgentCatalogDefinitions,
    isBundledAgentId,
    type AgentId,
} from '@happier-dev/agents';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

export function listAgentUniverseIds(): readonly AgentId[] {
    return getAllAgentCatalogDefinitions().map((definition) => definition.id);
}

/** Declaration containers remain administrable, but cannot seed executable preferences. */
export function listExecutableAgentUniverseIds(): readonly AgentId[] {
    return listAgentUniverseIds().filter((id) => isBundledAgentId(id)
        && listAgentExecutionTargetsV1(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[id]).length > 0);
}

export function buildAgentUniverseBackendTargetKey(id: string): string {
    const normalizedId = id.trim();
    return resolveBackendTargetKeyV2({
        kind: 'backend',
        backendId: normalizedId,
    });
}
