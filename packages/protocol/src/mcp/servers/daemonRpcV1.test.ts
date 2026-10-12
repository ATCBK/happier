import { describe, expect, it } from 'vitest';

import { MAX_AGENT_ROUTING_ID_BYTES } from '../../agents/agentIdV1.js';
import {
  DaemonMcpServersDetectRequestSchema,
  DaemonMcpServersDetectWarningV1Schema,
  DetectedMcpServerV1Schema,
  McpDetectedProviderV1Schema,
  DaemonMcpServersTestRequestSchema,
} from './daemonRpcV1';
import { resolveSessionCapabilitiesV1 } from '../../reach/resolveSessionCapabilitiesV1.js';

/**
 * Every Agent id the host bundles today, plus an externally contributed one.
 * MCP detection identity is Agent identity: it is open by contract, so no
 * static protocol enum may decide which Agents are allowed to be detected.
 */
const INSTALLED_AGENT_IDS = [
  'claude',
  'codex',
  'opencode',
  'antigravity',
  'gemini',
  'grok',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'cursor',
  'ohMyPi',
  'pi',
  'copilot',
  'coderabbit',
  'deepsec',
  'acme.cli',
] as const;

function remoteServer(provider: string) {
  return {
    provider,
    name: 'docs',
    transport: 'http',
    remote: { url: 'https://mcp.example.test/http', headers: [] },
    envKeys: [],
    enabled: null,
    source: { kind: 'user', path: 'plugin:config' },
  };
}

describe('MCP detection Agent identity on the V1 wire', () => {
  it('normalizes a retained draft Test request before using the canonical resolver', () => {
    // ../0.2 cd2bb4d853a259ae00ebc3e5981224e3e4bb5380:
    // daemonRpcV1.ts:98–107 and UI McpServerTestPanel.tsx:136–141 (both clean).
    const parsed = DaemonMcpServersTestRequestSchema.safeParse({ t: 'draft', machineId: 'm', directory: '/repo/child',
      server: { id: 'server', name: 'server', transport: 'stdio', stdio: { command: 'base', args: ['base'] }, env: { REGION: { t: 'literal', v: 'base' } }, createdAt: 1, updatedAt: 1 },
      binding: { id: 'folder', serverId: 'server', target: { t: 'workspace', machineId: 'm', workspaceRoot: '/repo' }, enabled: true,
        overrides: { stdio: { command: 'folder', args: ['folder'] }, envPatch: { REGION: { t: 'literal', v: 'folder' } } }, createdAt: 1, updatedAt: 1 },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.t !== 'draft' || !parsed.data.binding) throw new Error('Expected normalized draft');
    expect(parsed.data.binding).not.toHaveProperty('overrides');
    const resolved = resolveSessionCapabilitiesV1({ context: { machineId: 'm', directory: '/repo/child', machinePlatform: 'posix', projectKey: null, agentId: null },
      mcp: { v: 1, strictMode: true, servers: [parsed.data.server], bindings: [parsed.data.binding] }, skills: null, selection: {}, agentAcceptsUserMcp: true });
    expect(resolved.mcp.items[0]).toMatchObject({ selected: true, effectiveConfig: { stdio: { command: 'folder', args: ['folder'] }, env: { REGION: { t: 'literal', v: 'folder' } } } });
  });
  it('admits every installed Agent id, bundled or externally contributed', () => {
    for (const agentId of INSTALLED_AGENT_IDS) {
      expect(McpDetectedProviderV1Schema.parse(agentId)).toBe(agentId);
      expect(DetectedMcpServerV1Schema.safeParse(remoteServer(agentId)).success).toBe(true);
      expect(DaemonMcpServersDetectWarningV1Schema.safeParse({
        provider: agentId,
        code: 'parse_failed',
      }).success).toBe(true);
    }

    expect(DaemonMcpServersDetectRequestSchema.safeParse({
      machineId: 'machine-1',
      providers: [...INSTALLED_AGENT_IDS],
    }).success).toBe(true);
  });

  it('still rejects an unusable Agent id rather than accepting any string', () => {
    expect(McpDetectedProviderV1Schema.safeParse('').success).toBe(false);
    expect(McpDetectedProviderV1Schema.safeParse(' claude ').success).toBe(false);
    expect(McpDetectedProviderV1Schema.safeParse('a'.repeat(MAX_AGENT_ROUTING_ID_BYTES)).success).toBe(true);
    expect(McpDetectedProviderV1Schema.safeParse('a'.repeat(MAX_AGENT_ROUTING_ID_BYTES + 1)).success).toBe(false);
    expect(McpDetectedProviderV1Schema.safeParse(7).success).toBe(false);
  });

  it('carries a detection warning that no Agent owns so an unresolvable source stays visible', () => {
    const parsed = DaemonMcpServersDetectWarningV1Schema.safeParse({
      code: 'unsupported',
      path: 'plugin:acme.config',
      detail: 'Plugin MCP discovery source declares no Agent id',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.provider).toBeUndefined();
  });
});
