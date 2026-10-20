import { prepareDefaultProviderStateSharingChangeV1, prepareAgentProviderStateSharingChangeV1, AgentProviderStateSharingChangeV1Schema, readProviderStateSharingRiskAgentIdsV1, type ProviderStateSharingMutationServicesV1 } from '@happier-dev/protocol/actions/settings/providerStateSharingMutations';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginAgentCapabilitiesV2 } from '@happier-dev/protocol/plugins/contributions/v2';
import type { AgentId } from '@/agents/catalog/catalog';
import { BUNDLED_CANONICAL_AGENT_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import type { ConnectedServicesProviderStateSharingSettingsV1 } from '@happier-dev/protocol/account/settings/connected-services';

export type ProviderStateSharingSettingsMutation = (current: ConnectedServicesProviderStateSharingSettingsV1)
    => ConnectedServicesProviderStateSharingSettingsV1 | null;

type ProviderStateSharingAgent = Readonly<{
    agentId: AgentId;
    capability?: PluginAgentCapabilitiesV2['providerStateSharing'] | null;
}>;

/** Known declaration facts can render while incomplete authority still refuses mutation. */
function readProviderStateSharingCatalog(lifetime: ActiveServerAccountScopeLifetime | null) {
    const agents: ProviderStateSharingAgent[] = Object.entries(BUNDLED_CANONICAL_AGENT_DECLARATIONS)
        .map(([agentId, declaration]) => ({ agentId, capability: declaration.providerStateSharing }));
    if (!lifetime?.isCurrent()) return { agents, complete: false };
    const catalog = readPluginAccountAvailability(lifetime.scope).readInstalledPlugins();
    if (catalog.kind !== 'available') return { agents, complete: false };
    let complete = catalog.completeness === 'complete';
    for (const plugin of catalog.plugins) {
        for (const installation of plugin.installations) {
            const materialization = installation.materialization;
            if (!materialization.enabled) continue;
            // The generated declarations above own bundled source facts;
            // machine-bound bundled materializations do not replace them.
            if (materialization.sourceClass === 'bundledFirstParty') continue;
            if (installation.execution.validation.kind === 'rejected'
                && installation.execution.validation.reason === 'disabled') continue;
            if (installation.declarationState !== 'known' || !installation.declaration
                || installation.execution.validation.kind !== 'admitted') {
                complete = false;
                continue;
            }
            for (const definition of installation.declaration.contributes.agents ?? []) {
                // Installed portable Agents use the qualified external routing
                // id, even beside a bundled contribution with the same identity.
                const agentId = buildQualifiedPluginContributionKey({ pluginId: plugin.pluginId, localId: definition.id });
                agents.push({ agentId, capability: definition.capabilities.providerStateSharing });
            }
        }
    }
    return { agents, complete };
}

export function resolveProviderStateSharingAgentIds(agentIds?: readonly AgentId[]): readonly AgentId[] {
    const catalog = readProviderStateSharingCatalog(captureActiveServerAccountScopeLifetime());
    return [...new Set(catalog.agents.filter(({ agentId, capability }) => (!agentIds || agentIds.includes(agentId))
        && (capability?.config.supported === true || capability?.state.supported === true)).map(({ agentId }) => agentId))];
}

function sharingMutationServices(): ProviderStateSharingMutationServicesV1 {
    const lifetime = captureActiveServerAccountScopeLifetime();
    return {
        readProviderStateSharingRiskAgentIds: () => {
            const catalog = readProviderStateSharingCatalog(lifetime);
            return catalog.complete ? [...new Set(readProviderStateSharingRiskAgentIdsV1(catalog.agents))] : null;
        },
        // This preparation runs only after settings.set approval admission,
        // including a waiver. The transport acknowledgement is not a second floor.
        confirmProviderStateSharingRiskAgents: async () => true,
    };
}

export async function prepareAgentProviderStateSharingChange(settings: ConnectedServicesProviderStateSharingSettingsV1, value: unknown) {
    const change = AgentProviderStateSharingChangeV1Schema.safeParse(value);
    if (!change.success) return null;
    const result = await prepareAgentProviderStateSharingChangeV1(settings, change.data, sharingMutationServices());
    return result.status === 'prepared' ? result.mutate : null;
}

/** The admitted Settings Action supplies consent; only its catalog-backed intent is replayed. */
export async function prepareDefaultProviderStateSharingChange(
    settings: ConnectedServicesProviderStateSharingSettingsV1,
    shared: boolean,
): Promise<ProviderStateSharingSettingsMutation | null> {
    const result = await prepareDefaultProviderStateSharingChangeV1(settings, shared, sharingMutationServices());
    return result.status === 'prepared' ? result.mutate : null;
}
