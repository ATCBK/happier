import { describe, expect, it } from 'vitest';

import { McpServersSettingsV1Schema } from '../mcp/servers/settingsV1.js';
import { resolveRunnerMcpMaterialV1, RunnerMcpMaterialV1Schema } from './runnerMcpMaterial.js';

describe('resolveRunnerMcpMaterialV1', () => {
  it('freezes template secrets and their revisions while refusing endpoint environment variables', () => {
    const settings = McpServersSettingsV1Schema.parse({ servers: [{ id: 'tools', name: 'tools', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: { Authorization: { t: 'template', template: 'Bearer {key}',
        vars: { key: { t: 'savedSecret', secretId: 'token' } } } } }, env: {}, createdAt: 1, updatedAt: 2 }],
      bindings: [{ id: 'all', serverId: 'tools', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 2 }],
    });
    expect(resolveRunnerMcpMaterialV1({ agentId: 'claude', agentAcceptsUserMcp: true, settings,
      resolveSavedSecret: () => ({ value: 'secret', revision: 3 }) })).toMatchObject({ ok: true, material: { servers: [{
        savedSecretRevisions: [{ secretId: 'token', revision: 3 }],
        config: { remote: { headers: { Authorization: { t: 'literal', v: 'Bearer secret' } } } },
      }] } });
    expect(resolveRunnerMcpMaterialV1({ agentId: 'claude', agentAcceptsUserMcp: true, settings, resolveSavedSecret: () => null }))
      .toMatchObject({ ok: false, reason: 'saved_secret_unavailable', serverId: 'tools', valuePath: 'header:Authorization' });
    const machineVariable = { ...settings, servers: settings.servers.map(server => ({ ...server, env: {
      TOKEN: { t: 'template' as const, template: '{key}', vars: { key: { t: 'literal' as const, v: '${KEY}' } } },
    } })) };
    expect(resolveRunnerMcpMaterialV1({ agentId: 'claude', agentAcceptsUserMcp: true, settings: machineVariable,
      resolveSavedSecret: () => ({ value: 'secret', revision: 3 }) }))
      .toMatchObject({ ok: false, reason: 'endpoint_environment', serverId: 'tools', valuePath: 'env:TOKEN' });
  });
  it('preserves both capability selections while materializing the MCP subset', () => {
    const settings = McpServersSettingsV1Schema.parse({ servers: [], bindings: [] });
    const capabilitySelection = {
      mcp: { v: 1 as const, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] },
      skills: { v: 1 as const, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: [], excludeNativeSkillNames: ['native'] },
    };
    expect(resolveRunnerMcpMaterialV1({ agentId: 'claude', agentAcceptsUserMcp: true, settings, capabilitySelection, resolveSavedSecret: () => null }))
      .toMatchObject({ ok: true, material: { capabilitySelection } });
  });
  it('applies the authored Agent exception to portable reviewed material', () => {
    const settings = McpServersSettingsV1Schema.parse({
      servers: [{ id: 'tools', name: 'tools', transport: 'http', remote: { url: 'https://tools.example.test/mcp', headers: {} },
        env: {}, createdAt: 1, updatedAt: 2 }],
      bindings: [
        { id: 'everywhere', serverId: 'tools', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 2 },
        { id: 'except-codex', serverId: 'tools', target: { t: 'allMachines' }, agentId: 'codex', enabled: false, createdAt: 1, updatedAt: 2 },
      ],
    });
    expect(resolveRunnerMcpMaterialV1({ agentAcceptsUserMcp: true, settings, agentId: 'codex', resolveSavedSecret: () => null }))
      .toMatchObject({ ok: true, material: { servers: [] } });
    expect(resolveRunnerMcpMaterialV1({ agentAcceptsUserMcp: true, settings, agentId: 'claude', resolveSavedSecret: () => null }))
      .toMatchObject({ ok: true, material: { servers: [{ serverId: 'tools' }] } });
    expect(resolveRunnerMcpMaterialV1({ settings, agentId: 'claude', agentAcceptsUserMcp: false, resolveSavedSecret: () => null }))
      .toMatchObject({ ok: true, material: { servers: [] } });
  });
  it('retains symbolic Session headers until the runtime has its actual Session identity', () => {
    const headers = { 'X-Happier-Session': { t: 'sessionAttested', field: 'sessionId' },
      'X-Sender': { t: 'sessionAttested', field: 'externalPrincipalId' } } as const;
    const settings = McpServersSettingsV1Schema.parse({ servers: [{ id: 'wilson', name: 'wilson', transport: 'http',
      remote: { url: 'https://wilson.example.test/mcp', headers }, env: {}, createdAt: 1, updatedAt: 2 }],
      bindings: [{ id: 'all', serverId: 'wilson', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 2 }] });
    const result = resolveRunnerMcpMaterialV1({ settings, agentId: 'claude', agentAcceptsUserMcp: true,
      capabilitySelection: null, resolveSavedSecret: () => null });
    expect(result).toMatchObject({ ok: true, material: { servers: [{ config: { remote: { headers } } }] } });
  });
  it('refuses an explicit MCP include when the authored Agent cannot receive user servers', () => {
    const settings = McpServersSettingsV1Schema.parse({ servers: [{ id: 'tools', name: 'tools', transport: 'http',
      remote: { url: 'https://tools.example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 2 }],
      bindings: [{ id: 'all', serverId: 'tools', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 2 }] });
    expect(resolveRunnerMcpMaterialV1({ settings, agentId: 'claude', agentAcceptsUserMcp: false,
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['tools'], forceExcludeServerIds: [] } },
      resolveSavedSecret: () => null,
    })).toEqual({ ok: false, reason: 'agent_unsupported', serverId: 'tools', valuePath: null });
  });

  it('freezes the exact portable selection revisions and resolved secret material', () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: true,
      servers: [{
        id: 'github', name: 'github', transport: 'http',
        remote: { url: 'https://mcp.example.test', headers: { Authorization: { t: 'savedSecret', secretId: 'token' } } },
        env: {}, createdAt: 10, updatedAt: 20,
      }],
      bindings: [{ id: 'all', serverId: 'github', enabled: true, target: { t: 'allMachines' }, createdAt: 30, updatedAt: 40 }],
    });

    expect(resolveRunnerMcpMaterialV1({ agentId: 'claude', agentAcceptsUserMcp: true,
      settings,
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['github'], forceExcludeServerIds: [] } },
      resolveSavedSecret: (id) => id === 'token' ? { value: 'Bearer reviewed-secret', revision: 15 } : null,
    })).toEqual({
      ok: true,
      material: {
        v: 1,
        strictMode: true,
        capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['github'], forceExcludeServerIds: [] } },
        servers: [{
          serverId: 'github', serverRevision: 20, bindingId: 'all', bindingRevision: 40,
          savedSecretRevisions: [{ secretId: 'token', revision: 15 }],
          config: {
            id: 'github', name: 'github', transport: 'http',
            remote: { url: 'https://mcp.example.test', headers: { Authorization: { t: 'literal', v: 'Bearer reviewed-secret' } } },
            env: {}, createdAt: 10, updatedAt: 20,
          },
        }],
      },
    });
  });

  it('materializes an explicit include independently of another Machine default', () => {
    const settings = McpServersSettingsV1Schema.parse({
      servers: [{ id: 'local', name: 'local', transport: 'stdio', stdio: { command: 'tool', args: [] }, env: {}, createdAt: 1, updatedAt: 2 }],
      bindings: [{ id: 'machine', serverId: 'local', enabled: true, target: { t: 'machine', machineId: 'm1' }, createdAt: 3, updatedAt: 4 }],
    });
    expect(resolveRunnerMcpMaterialV1({ agentId: 'claude', agentAcceptsUserMcp: true,
      settings,
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['local'], forceExcludeServerIds: [] } },
      resolveSavedSecret: () => null,
    })).toMatchObject({ ok: true, material: { servers: [{ serverId: 'local', serverRevision: 2,
      bindingId: null, bindingRevision: null, config: settings.servers[0] }] } });
  });

  it('does not reinterpret a removed selected server as a portability failure', () => {
    const settings = McpServersSettingsV1Schema.parse({ servers: [], bindings: [] });
    expect(resolveRunnerMcpMaterialV1({ agentId: 'claude', agentAcceptsUserMcp: true,
      settings,
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['removed'], forceExcludeServerIds: [] } },
      resolveSavedSecret: () => null,
    })).toEqual({ ok: false, reason: 'server_unavailable', serverId: 'removed', valuePath: null });
  });

  it('materializes an explicit include after its default binding was removed', () => {
    const settings = McpServersSettingsV1Schema.parse({
      servers: [{ id: 'unbound', name: 'unbound', transport: 'stdio', stdio: { command: 'tool', args: [] }, env: {}, createdAt: 1, updatedAt: 2 }],
      bindings: [],
    });
    expect(resolveRunnerMcpMaterialV1({ agentId: 'claude', agentAcceptsUserMcp: true,
      settings,
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['unbound'], forceExcludeServerIds: [] } },
      resolveSavedSecret: () => null,
    })).toMatchObject({ ok: true, material: { servers: [{ serverId: 'unbound', serverRevision: 2,
      bindingId: null, bindingRevision: null, config: settings.servers[0] }] } });
  });

  it('rejects a reviewed server whose bound identity revision was substituted', () => {
    expect(RunnerMcpMaterialV1Schema.safeParse({
      v: 1,
      strictMode: true,
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
      servers: [{
        serverId: 'server-a', serverRevision: 3, bindingId: null, bindingRevision: null,
        savedSecretRevisions: [],
        config: {
          id: 'server-a', name: 'server-a', transport: 'stdio',
          stdio: { command: 'tool', args: [] }, env: {}, createdAt: 1, updatedAt: 2,
        },
      }],
    }).success).toBe(false);
  });

  it('returns a source-specific refusal for an unresolved environment template', () => {
    const settings = McpServersSettingsV1Schema.parse({
      servers: [{ id: 'env', name: 'env', transport: 'stdio', stdio: { command: 'tool', args: [] }, env: { TOKEN: { t: 'literal', v: '${TOKEN}' } }, createdAt: 1, updatedAt: 2 }],
      bindings: [{ id: 'all', serverId: 'env', enabled: true, target: { t: 'allMachines' }, createdAt: 3, updatedAt: 4 }],
    });
    expect(resolveRunnerMcpMaterialV1({ agentId: 'claude', agentAcceptsUserMcp: true, settings, capabilitySelection: null, resolveSavedSecret: () => null }))
      .toEqual({ ok: false, reason: 'endpoint_environment', serverId: 'env', valuePath: 'env:TOKEN' });
  });
});
