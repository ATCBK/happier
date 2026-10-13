import { describe, expect, it } from 'vitest';

import { buildKiloAcpEnv, buildKiloAcpToolNameResolver } from './callbacks.js';

describe('Kilo ACP callbacks', () => {
  it('uses the longest known MCP key and recovers native tool spellings without claiming unknown tools', () => {
    const resolver = buildKiloAcpToolNameResolver({
      mcpServers: { docs: { command: '/fixture' }, 'docs.team__prod': { command: '/fixture' } },
      mcpToolPolicy: { 'docs.team__prod': { unlisted: 'ask', tools: Object.fromEntries([['file.read', 'off'], ['__proto__', 'off']] as const) } },
    });
    expect(resolver({ toolName: 'other', input: { _acp: { title: 'docs_team__prod_file_read' } } })).toBe('mcp__docs.team__prod__file.read');
    expect(resolver({ toolName: 'docs_team__prod___proto__', input: {} })).toBe('mcp__docs.team__prod____proto__');
    expect(resolver({ toolName: 'unknown_file_read', input: {} })).toBe('unknown_file_read');
  });
  it('injects canonical-permission-aware KILO_PERMISSION without mutating host env', () => {
    const env = buildKiloAcpEnv({
      launchEnvironment: {
        values: { DEBUG: 'transport-debug' },
        unset: [],
      },
      permissionIntent: 'read-only',
    });

    expect(JSON.parse(env.KILO_PERMISSION)).toMatchObject({
      '*': 'deny',
      read: 'allow',
      edit: 'deny',
      bash: 'deny',
      external_directory: 'deny',
    });
    expect(env).not.toHaveProperty('DEBUG');
  });
});
