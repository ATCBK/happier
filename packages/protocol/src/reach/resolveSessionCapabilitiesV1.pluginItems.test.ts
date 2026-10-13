import { describe, expect, it } from 'vitest';
import { McpServerCatalogEntryV1Schema, McpServersSettingsV1Schema, mcpPluginItemIdV1, type McpPluginItemV1 } from '../mcp/servers/settingsV1.js';
import { resolveSessionCapabilitiesV1 } from './resolveSessionCapabilitiesV1.js';

describe('plugin MCP reach and session selection', () => {
  it('resolves plugin and catalog items together, retaining Off and applying session inclusion', () => {
    const itemId = mcpPluginItemIdV1({ pluginId: 'acme.tools', localId: 'docs/nested' });
    const config = McpServerCatalogEntryV1Schema.parse({ id: itemId, name: 'docs', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 0, updatedAt: 0 });
    const rule = { id: 'plugin-rule', serverId: itemId, target: { t: 'allMachines' as const }, enabled: false, createdAt: 1, updatedAt: 1 };
    const mcp = McpServersSettingsV1Schema.parse({ v: 1, servers: [], bindings: [rule] });
    const item: McpPluginItemV1 = { itemId, name: 'docs', config, rules: [rule] };
    const input = { context: { machineId: 'machine', machinePlatform: 'posix' as const, directory: '/repo', projectKey: null, agentId: 'claude' },
      mcp, mcpPluginItems: [item], skills: null, selection: {}, agentAcceptsUserMcp: true };
    expect(resolveSessionCapabilitiesV1(input).mcp.items).toEqual([expect.objectContaining({ id: itemId,
      source: 'plugin', selected: false, reason: 'rule_off', effectiveConfig: config })]);
    const selected = resolveSessionCapabilitiesV1({ ...input, selection: { mcp: { v: 1, managedServersEnabled: true,
      forceIncludeServerIds: [itemId], forceExcludeServerIds: [] } } });
    expect(selected.mcp.items[0]).toMatchObject({ selected: true, reason: 'session_added', effectiveConfig: config });
    expect(resolveSessionCapabilitiesV1({ ...input, agentAcceptsUserMcp: false }).mcp.items[0])
      .toMatchObject({ selected: false, reason: 'agent_unsupported' });
    expect(resolveSessionCapabilitiesV1({ ...input, mcpPluginItems: [] }).mcp.items).toEqual([]);
    expect(McpServersSettingsV1Schema.safeParse({ ...mcp, bindings: [{ ...rule, serverId: 'missing' }] }).success).toBe(false);
  });
});
