import { PluginMcpServerContributionV1Schema } from '../../plugins/contributions/mcp.js';
import type { PluginProjectionV2 } from '../../daemon/contributionRegistryProjection.js';
import { projectMcpPluginItemMetadataV1, type McpPluginItemMetadataV1 } from './settingsV1.js';

/** Declaration admission stays out of the Account settings schema's module graph. */
export function readMcpPluginItemMetadataFromProjectionV1(projection: PluginProjectionV2): readonly McpPluginItemMetadataV1[] {
  return Object.values(projection.familiesById.mcp?.entriesById ?? {}).flatMap(entry => {
    if (entry.contributionKind !== 'server' || !entry.pluginId || projection.installedPackagesById[entry.pluginId]?.enabled === false) return [];
    const server = PluginMcpServerContributionV1Schema.parse({ id: entry.localId, title: entry.title,
      ...(entry.description ? { description: entry.description } : {}), kind: entry.kind,
      ...(entry.transport ? { transport: entry.transport } : {}), ...(entry.sessionScope ? { sessionScope: entry.sessionScope } : {}) });
    return [projectMcpPluginItemMetadataV1({ pluginId: entry.pluginId,
      pluginName: projection.installedPackagesById[entry.pluginId]?.displayName ?? entry.pluginId, server })];
  });
}
