import { describe, expect, it } from 'vitest';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { resolveSpawnMcpServersPreviewInventory } from '@/session/actions/cliActionDeps/resolveSpawnMcpServersPreviewInventory';

import { resolveSessionMcpPreview } from './resolveSessionMcpPreview';

describe('resolveSessionMcpPreview detection warnings', () => {
  it('applies the generic carrier MCP override through the canonical preview producer', () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, servers: [{
      id: 'server-a', name: 'example', transport: 'stdio', stdio: { command: 'example', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'everywhere', serverId: 'server-a', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    const preview = resolveSessionMcpPreview({ settings, machineId: 'machine-1', directory: '/repo', agentId: 'codex',
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['server-a'] },
        skills: { v: 1, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] } },
      detectedServers: [],
    });
    expect(preview.managed).toEqual([expect.objectContaining({ serverId: 'server-a', selected: false, reasonCode: 'forced_excluded' })]);
  });
  it('projects admitted managed options without disclosing env or header material', async () => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'remote', name: 'remote-tools', transport: 'http', remote: { url: 'https://mcp.example.test',
        headers: { Authorization: { t: 'literal', v: 'private-header-material' } } },
      env: { API_TOKEN: { t: 'literal', v: 'private-env-material' } }, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'binding', serverId: 'remote', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] });
    // This port replaces provider OS discovery, not preview or selection logic.
    const result = await resolveSpawnMcpServersPreviewInventory({ settings, machineId: 'machine-1', directory: '/workspace',
      agentId: 'codex', deps: { detectProviderMcpServers: async () => ({ servers: [{
        provider: 'codex', name: 'detected-tools', transport: 'stdio', stdio: { command: 'echo', args: [] },
        envKeys: ['TOKEN'], enabled: true, source: { kind: 'user', path: '/config/codex' },
      }], warnings: [] }) },
    });
    expect(result).toMatchObject({ ok: true,
      items: expect.arrayContaining([{ value: 'managed:remote', label: 'remote-tools', selected: true, selectable: true,
        sourceKind: 'managed', authMode: 'plainText', availability: 'active' }]),
      preview: { managed: [expect.objectContaining({ serverId: 'remote', transport: 'http', scopeKind: 'allMachines' })],
        detected: [expect.objectContaining({ key: 'detected:codex:detected-tools', envKeyCount: 1 })] },
    });
    expect(JSON.stringify(result)).not.toContain('private-env-material');
    expect(JSON.stringify(result)).not.toContain('private-header-material');
  });

  it('renders a detection warning that no Agent owns without an undefined Agent id', () => {
    const preview = resolveSessionMcpPreview({
      settings: { v: 1, strictMode: false, servers: [], bindings: [] },
      machineId: 'machine-1',
      directory: '/tmp/project',
      agentId: 'gemini',
      detectedServers: [],
      detectedWarnings: [
        { provider: 'gemini', code: 'parse_failed', path: '/tmp/project/.gemini/mcp.json' },
        { code: 'unsupported', path: 'plugin:config' },
      ],
    });

    expect(preview.warnings).toEqual([
      'gemini:parse_failed:/tmp/project/.gemini/mcp.json',
      'unattributed:unsupported:plugin:config',
    ]);
  });
});
