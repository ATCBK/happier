import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { buildQualifiedPluginContributionKey, qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';

export type ProcessRoleCatalog = Readonly<{
    agentExecutables: readonly Readonly<{ name: string; executable: string }>[];
    mcpServers: readonly Readonly<{ name: string; executable: string }>[];
}>;

/** Current contribution metadata, not another executable/provider catalog. */
export function projectProcessRoleCatalog(registry: Pick<ResolvedContributionRegistry,
    'catalogEntriesById' | 'agentDefinitionsById' | 'systemToolsById' | 'managedDependenciesByKey' | 'mcpServers'>): ProcessRoleCatalog {
    const agentExecutables = Object.values(registry.catalogEntriesById).flatMap(agent => {
        const toolId = agent.agentCliSystemTool?.toolId;
        const pluginId = registry.agentDefinitionsById.get(agent.id)?.pluginId;
        const key = toolId && pluginId ? buildQualifiedPluginContributionKey(qualifyPluginContributionReferenceV1(toolId, pluginId)) : toolId;
        const tool = key ? registry.systemToolsById?.get(key) : undefined;
        return tool?.definition.executableNames.map(executable => ({ name: agent.rootHelpLabel ?? agent.id, executable })) ?? [];
    });
    const mcpServers = (registry.mcpServers ?? []).flatMap(server => {
        const definition = server.definition;
        if (definition.kind !== 'static' || definition.transport.kind !== 'stdio') return [];
        const ref = definition.transport.executable;
        const name = definition.id;
        if (typeof ref.id === 'string' && !server.pluginId) return [];
        const identity = qualifyPluginContributionReferenceV1(ref.id, server.pluginId ?? '');
        const key = buildQualifiedPluginContributionKey(identity);
        if (ref.kind === 'systemTool') {
            return registry.systemToolsById?.get(key)?.definition.executableNames.map(executable => ({ name, executable })) ?? [];
        }
        const dependency = (registry.managedDependenciesByKey?.get(key)
            ?? [...registry.managedDependenciesByKey?.values() ?? []].find(item => item.pluginId === identity.pluginId && item.definition.id === identity.localId))?.definition;
        if (!dependency) return [];
        if ('binary' in dependency) return dependency.binary.commands.map(executable => ({ name, executable }));
        return 'executable' in dependency && typeof dependency.executable === 'string' ? [{ name, executable: dependency.executable }] : [];
    });
    return { agentExecutables, mcpServers };
}

export function readProcessRoleCatalog(): ProcessRoleCatalog {
    return projectProcessRoleCatalog(readCurrentContributionRegistry());
}
