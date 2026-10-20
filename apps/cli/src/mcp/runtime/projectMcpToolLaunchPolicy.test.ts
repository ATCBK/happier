import { describe, expect, it } from 'vitest';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { projectMcpToolLaunchPolicies } from './projectMcpToolLaunchPolicy';
describe('host MCP launch policy', () => {
  const catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{ id: 'docs-id', name: 'docs', transport: 'stdio', stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    tools: { default: 'allow_all', overrides: { write: 'off' } }, toolsSnapshot: { checkedAt: 1, machineId: 'machine', tools: [{ name: 'read', tokens: 1 }, { name: 'write', tokens: 1 }] } }] };
  const input = { catalog, mcpServerIdentities: { docs_2: { serverId: 'docs-id', serverTitle: 'Docs' } }, permissionMode: 'default' as const };
  it('host mediation projects native Allow as Ask, retaining Off and denying mode ceilings', () => {
    expect(projectMcpToolLaunchPolicies({ ...input, control: { off: 'blocked', approval: 'host' } })).toEqual({ docs_2: { unlisted: 'ask', tools: { read: 'ask', write: 'off' } } });
    expect(projectMcpToolLaunchPolicies({ ...input, permissionMode: 'read-only', control: { off: 'blocked', approval: 'host' } })).toEqual({ docs_2: { unlisted: 'deny', tools: { read: 'deny', write: 'off' } } });
  });
  it('absent declarations receive no policy and native control receives the resolver projection', () => {
    expect(projectMcpToolLaunchPolicies(input)).toBeUndefined();
    expect(projectMcpToolLaunchPolicies({ ...input, control: { off: 'hidden', approval: 'native' } })).toEqual({ docs_2: { unlisted: 'allow', tools: { read: 'allow', write: 'off' } } });
  });
  it.each([
    { permissionMode: 'default' as const, unlisted: 'ask' },
    { permissionMode: 'yolo' as const, unlisted: 'allow' },
    { permissionMode: 'read-only' as const, unlisted: 'deny' },
  ])('uses canonical defaults for an admitted plugin with no settings in $permissionMode', ({ permissionMode, unlisted }) => {
    expect(projectMcpToolLaunchPolicies({ catalog: { v: 1, servers: [], bindings: [] }, permissionMode,
      control: { off: 'hidden', approval: 'native' }, mcpServerIdentities: {
        plugin: { serverId: 'plugin:acme.tools/docs', serverTitle: 'Docs', plugin: { pluginId: 'acme.tools', localId: 'docs' } },
        missing: { serverId: 'missing-user-server', serverTitle: 'Missing' },
      } })).toEqual({ plugin: { unlisted, tools: {} }, missing: { unlisted: 'deny', tools: {} } });
  });
});
