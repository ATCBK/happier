import type { AgentId } from '@/agents/registry/registryCore';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';
import {
    getAgentBackendCompatibilityTargetKeys,
    readBackendTargetEnabled,
} from '@/agents/backendCatalog/backendTargetEnablement';
import { buildAgentUniverseBackendTargetKey, listExecutableAgentUniverseIds } from '@/agents/catalog/agentUniverse';
import { getAgentModelConfig, isBundledAgentId } from '@happier-dev/agents';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';

export function isAgentEnabled(params: {
    agentId: AgentId;
    backendEnabledByTargetKey: Record<string, boolean> | null | undefined;
}): boolean {
    if (isBundledAgentId(params.agentId)
        && listAgentExecutionTargetsV1(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[params.agentId]).length === 0) return false;
    const targetKey = buildAgentUniverseBackendTargetKey(params.agentId);
    return readBackendTargetEnabled({
        backendEnabledByTargetKey: params.backendEnabledByTargetKey,
        canonicalTargetKey: targetKey,
        compatibilityTargetKeys: getAgentBackendCompatibilityTargetKeys({
            agentId: params.agentId,
            canonicalTargetKey: targetKey,
        }),
    });
}

export function getEnabledAgentIds(params: {
    backendEnabledByTargetKey: Record<string, boolean> | null | undefined;
}): AgentId[] {
    const executableAgentIds = new Set(listExecutableAgentUniverseIds());
    return CANONICAL_AGENT_IDS.filter((agentId) => {
        const modelConfig = getAgentModelConfig(agentId);
        return executableAgentIds.has(agentId) && modelConfig?.supportsSelection !== false
            && isAgentEnabled({ agentId, backendEnabledByTargetKey: params.backendEnabledByTargetKey });
    });
}
