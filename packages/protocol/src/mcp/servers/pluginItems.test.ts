import { describe, expect, it } from 'vitest';
import { mcpPluginItemIdV1, projectMcpPluginItemMetadataV1 } from './settingsV1.js';
import { McpServerCatalogV1Schema } from './serverRowsV1.js';
import { applyMcpServerCatalogMutationV1, commitMcpServerCatalogMutationV1 } from './serverCatalogV1.js';
import { createMcpServerActionExecuteV1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from './serverActionsV1.js';
import { PluginMcpServerContributionV1Schema } from '../../plugins/contributions/mcp.js';

describe('plugin MCP catalog writes', () => {
  it('seeds once, preserves Off across install, and runs rules/tools/Undo through their strict consumers', async () => {
    const serverId = mcpPluginItemIdV1({ pluginId: 'acme.tools', localId: 'docs/nested' });
    const declaration = PluginMcpServerContributionV1Schema.parse({ id: 'docs/nested', kind: 'dynamic', title: 'Docs' });
    const metadata = projectMcpPluginItemMetadataV1({ pluginId: 'acme.tools', pluginName: 'Acme', server: declaration });
    let catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] });
    let revision = 1;
    const ctx = { nowMs: 42, newId: () => 'rules-change', pluginItemIds: [metadata.id] };
    catalog = applyMcpServerCatalogMutationV1(catalog, { kind: 'plugin-defaults', serverIds: [serverId] }, ctx);
    expect(catalog.bindings).toEqual([{ id: 'plugin-default:acme.tools/docs/nested', serverId,
      target: { t: 'allMachines' }, enabled: true, createdAt: 42, updatedAt: 42 }]);
    expect(applyMcpServerCatalogMutationV1(catalog, { kind: 'plugin-defaults', serverIds: [serverId] }, ctx)).toBe(catalog);
    const execute = createMcpServerActionExecuteV1({
      readCatalog: async () => ({ status: 'ready', catalog, revision, authority: 'active', diagnostics: [] }),
      readPluginItems: async () => [metadata],
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, scope: null, change, ctx,
        writeCatalog: async write => {
          if (expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = McpServerCatalogV1Schema.parse(write.catalog); revision++;
          return { status: 'updated', revision, cursor: revision };
        } }),
      machine: async () => { throw new Error('No machine operation expected'); },
    });
    const context = { surface: 'ui' as const };
    const rules = await execute({ actionId: 'mcp.rules.set', input: { items: [{ serverId }], change: {
      kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } } }, context });
    expect(rules).toMatchObject({ ok: true, result: { ok: true, items: [{ serverId, rules: [{ enabled: false }] }] } });
    const off = catalog;
    expect(applyMcpServerCatalogMutationV1(catalog, { kind: 'plugin-defaults', serverIds: [serverId] }, ctx)).toBe(off);
    const changed = await execute({ actionId: 'mcp.servers.tools.set', input: { serverId, tools: { echo: 'off' } }, context });
    if (!changed.ok) throw new Error(changed.error);
    const receipt = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.set'].parse(changed.result);
    expect(catalog.pluginServers?.[serverId]?.tools?.overrides).toEqual({ echo: 'off' });
    await execute({ actionId: 'mcp.servers.tools.set', input: { serverId, ...receipt.previous }, context });
    expect(catalog.pluginServers?.[serverId]?.tools?.overrides).toEqual({});
    const listed = await execute({ actionId: 'mcp.servers.list', input: {}, context });
    if (!listed.ok) throw new Error(listed.error);
    expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(listed.result)).toMatchObject({
      catalog: { servers: [{ id: serverId, source: { kind: 'plugin', pluginName: 'Acme' } }] },
    });
    expect(await execute({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'plugin:missing/tools' }], change: {
      kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } }, context })).toMatchObject({ ok: true, result: { ok: false, code: 'not_found' } });
  });
});
