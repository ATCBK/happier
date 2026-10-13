import { describe, expect, it } from 'vitest';
import { McpServerCatalogEntryV1Schema, McpServersSettingsV1Schema, mcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { projectPluginMcpServerItems } from './pluginMcpServerItems';
import type { ResolvedMcpServerContribution } from '@/plugins/projection/registry/types';

describe('declared plugin MCP items', () => {
  it('maps each transport and stored rules through the catalog consumer', async () => {
    const declaration = (id: string, definition: ResolvedMcpServerContribution['definition']): ResolvedMcpServerContribution => ({
      pluginId: 'acme.tools', provenance: 'external', source: { kind: 'path' }, definition: { ...definition, id },
    });
    const itemId = mcpPluginItemIdV1({ pluginId: 'acme.tools', localId: 'docs/nested' });
    const catalog = McpServersSettingsV1Schema.parse({ bindings: [{ id: 'off', serverId: itemId,
      target: { t: 'allMachines' }, enabled: false, createdAt: 1, updatedAt: 1 }] });
    const items = await projectPluginMcpServerItems({ catalog, activePlugins: [
      declaration('docs/nested', { id: 'docs/nested', kind: 'static', title: 'Docs', transport: { kind: 'http', url: 'https://example.test/mcp' } }),
      declaration('local', { id: 'local', kind: 'static', title: 'Local', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'echo' }, args: ['declared'] } }),
      declaration('live', { id: 'live', kind: 'dynamic', title: 'Live', sessionScope: 'session' }),
      declaration('happier', { id: 'happier', kind: 'dynamic', title: 'Reserved local name', sessionScope: 'global' }),
    ], resolveExecutable: async () => ({ command: '/tools/echo', args: ['owner'] }) });
    expect(items.map(item => McpServerCatalogEntryV1Schema.parse(item.config).id)).toEqual([
      itemId, 'plugin:acme.tools/local', 'plugin:acme.tools/live', 'plugin:acme.tools/happier',
    ]);
    expect(items[0]).toMatchObject({ itemId, name: 'docs_nested', title: 'Docs', rules: catalog.bindings });
    expect(items[1]?.config.stdio).toEqual({ command: '/tools/echo', args: ['owner', 'declared'] });
    expect(items[2]?.config.transport).toBe('http');
    expect(items[3]?.config.name).not.toBe('happier');
  });
});
