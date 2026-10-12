import { prepareDefaultProviderStateSharingChangeV1, prepareAgentProviderStateSharingChangeV1, AgentProviderStateSharingChangeV1Schema, readProviderStateSharingRiskAgentIdsV1, type ProviderStateSharingMutationServicesV1 } from '@happier-dev/protocol/actions/settings/providerStateSharingMutations';
import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { ConnectedServicesProviderStateSharingSettingsV1 } from '@happier-dev/protocol/account/settings/connected-services';

export type ProviderStateSharingSettingsMutation = (current: ConnectedServicesProviderStateSharingSettingsV1)
    => ConnectedServicesProviderStateSharingSettingsV1 | null;

export function resolveProviderStateSharingAgentIds(agentIds: readonly AgentId[] = AGENT_IDS): readonly AgentId[] {
    return agentIds.filter(agentId => {
        const capability = getAgentCore(agentId)?.connectedServices?.providerStateSharing;
        return capability?.config.supported === true || capability?.state.supported === true;
    });
}

function sharedStateRiskAgents(agentIds: readonly AgentId[]) {
    const agents = agentIds.flatMap(agentId => {
        const core = getAgentCore(agentId);
        return core ? [{ agentId, capability: core.connectedServices?.providerStateSharing }] : [];
    });
    const riskIds = new Set(readProviderStateSharingRiskAgentIdsV1(agents));
    return agents.filter(agent => riskIds.has(agent.agentId));
}

function sharingMutationServices(agentIds: readonly AgentId[]): ProviderStateSharingMutationServicesV1 {
    return {
        readProviderStateSharingRiskAgentIds: () => sharedStateRiskAgents(agentIds).map(entry => entry.agentId),
        // This preparation runs only after settings.set approval admission,
        // including a waiver. The transport acknowledgement is not a second floor.
        confirmProviderStateSharingRiskAgents: async () => true,
    };
}

export async function prepareAgentProviderStateSharingChange(settings: ConnectedServicesProviderStateSharingSettingsV1, value: unknown) {
    const change = AgentProviderStateSharingChangeV1Schema.safeParse(value);
    if (!change.success) return null;
    const result = await prepareAgentProviderStateSharingChangeV1(settings, change.data, sharingMutationServices(AGENT_IDS));
    return result.status === 'prepared' ? result.mutate : null;
}

/** The admitted Settings Action supplies consent; only its catalog-backed intent is replayed. */
export async function prepareDefaultProviderStateSharingChange(
    settings: ConnectedServicesProviderStateSharingSettingsV1,
    shared: boolean,
    agentIds: readonly AgentId[] = resolveProviderStateSharingAgentIds(),
): Promise<ProviderStateSharingSettingsMutation | null> {
    const result = await prepareDefaultProviderStateSharingChangeV1(settings, shared, sharingMutationServices(agentIds));
    return result.status === 'prepared' ? result.mutate : null;
}
