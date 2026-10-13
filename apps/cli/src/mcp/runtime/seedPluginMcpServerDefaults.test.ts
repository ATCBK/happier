import { describe, expect, it } from 'vitest';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { applyMcpServerCatalogMutationV1, commitMcpServerCatalogMutationV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { PluginMcpServerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/mcp';
import { mcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { CliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import { seedPluginMcpServerDefaults } from './seedPluginMcpServerDefaults';

describe('plugin installation default rules', () => {
  it('uses the canonical CAS reducer once and preserves a later Off rule on reinstall', async () => {
    const pluginId = 'acme.defaults';
    const serverId = mcpPluginItemIdV1({ pluginId, localId: 'tools' });
    let catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] });
    let revision = 1;
    const ctx = { nowMs: 1, newId: () => 'change', pluginItemIds: [serverId] };
    // Only the persistent row is substituted; admission, default reach and CAS reducer are real.
    const store: Pick<CliMcpServerStore, 'readCatalogForOperation' | 'mutate'> = {
      readCatalogForOperation: async () => ({ status: 'ready', catalog, revision, authority: 'active', diagnostics: [] }),
      mutate: async (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, ctx, scope: null,
        writeCatalog: async write => {
          if (expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = McpServerCatalogV1Schema.parse(write.catalog); revision++;
          return { status: 'updated', revision, cursor: revision };
        } }),
    };
    const input = { store, declarations: [{ pluginId, provenance: 'external' as const, source: { kind: 'path' as const },
      definition: PluginMcpServerContributionV1Schema.parse({ id: 'tools', title: 'Tools', kind: 'dynamic' }) }] };
    await seedPluginMcpServerDefaults(input);
    expect(catalog.bindings).toEqual([{ id: 'plugin-default:acme.defaults/tools', serverId,
      target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }]);
    await seedPluginMcpServerDefaults(input);
    expect(revision).toBe(2);
    catalog = applyMcpServerCatalogMutationV1(catalog, { kind: 'rules-change', serverIds: [serverId],
      change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } } }, ctx);
    const off = catalog;
    await seedPluginMcpServerDefaults(input);
    expect(catalog).toBe(off);
    expect(catalog.bindings[0]?.enabled).toBe(false);
    expect(revision).toBe(2);
  });
});
