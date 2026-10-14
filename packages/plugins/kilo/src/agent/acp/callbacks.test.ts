import { describe, expect, it } from 'vitest';

import { buildKiloAcpEnv, buildKiloAcpToolNameResolver } from './callbacks.js';

describe('Kilo ACP callbacks', () => {
  it('maps only injective MCP tool spellings and leaves other tools unchanged', () => {
    const resolver = buildKiloAcpToolNameResolver({
      mcpServers: { 'docs.team': { command: '/fixture' } },
    });
    expect(resolver({ toolName: 'other', toolCallId: 'call', context: { toolCallCountSincePrompt: 1 }, input: { _acp: { title: 'docs_team_echo' } } })).toBe('mcp__docs.team__echo');
    expect(resolver({ toolName: 'unknown_file_read', toolCallId: 'call', context: { toolCallCountSincePrompt: 1 }, input: {} })).toBe('unknown_file_read');
  });

  it('refuses lossy tool aliases even when a birth policy names one candidate', () => {
    const birthRequest = {
      mcpServers: { docs: { command: '/fixture' } },
      mcpToolPolicy: { docs: { unlisted: 'ask', tools: { 'file.read': 'ask' } } },
    };
    const resolver = buildKiloAcpToolNameResolver(birthRequest);
    expect(() => resolver({ toolName: 'docs_file_read', toolCallId: 'call', context: { toolCallCountSincePrompt: 1 }, input: {} })).toThrow();
  });

  it('refuses server alias collisions and ambiguous server/tool boundaries', () => {
    for (const names of [['docs.team', 'docs_team'], ['docs', 'docs_team']]) {
      const resolver = buildKiloAcpToolNameResolver({ mcpServers: Object.fromEntries(names.map(name => [name, { command: '/fixture' }])) });
      expect(() => resolver({ toolName: 'docs_team_echo', toolCallId: 'call', context: { toolCallCountSincePrompt: 1 }, input: {} })).toThrow();
    }
  });
  it('leaves the built-in Happier tool spelling to its Action permission owner', () => {
    const resolver = buildKiloAcpToolNameResolver({ mcpServers: { happier: { command: '/fixture' } } });
    expect(resolver({ toolName: 'other', toolCallId: 'call', context: { toolCallCountSincePrompt: 1 }, input: { _acp: { title: 'happier_session_start' } } })).toBe('happier_session_start');
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
