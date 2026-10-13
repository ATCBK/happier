import { mcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { CliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import type { ResolvedMcpServerContribution } from '@/plugins/projection/registry/types';

/** Install publication calls this once; session reads never invent default rules. */
export async function seedPluginMcpServerDefaults(input: Readonly<{
  declarations: readonly ResolvedMcpServerContribution[];
  store: Pick<CliMcpServerStore, 'readCatalogForOperation' | 'mutate'>;
}>): Promise<void> {
  if (input.declarations.length === 0) return;
  const snapshot = await input.store.readCatalogForOperation();
  if (snapshot.status !== 'ready' || snapshot.authority !== 'active') throw new Error('mcp_catalog_unavailable');
  const serverIds = input.declarations.flatMap(entry => {
    if (!entry.pluginId) throw new Error('Plugin MCP declaration has no owner');
    const serverId = mcpPluginItemIdV1({ pluginId: entry.pluginId, localId: entry.definition.id });
    return snapshot.catalog.bindings.some(rule => rule.serverId === serverId) ? [] : [serverId];
  });
  if (serverIds.length === 0) return;
  const receipt = await input.store.mutate({ kind: 'plugin-defaults', serverIds }, snapshot.revision, snapshot);
  if (receipt.status !== 'updated') throw new Error(`mcp_plugin_defaults_${receipt.status}`);
}
