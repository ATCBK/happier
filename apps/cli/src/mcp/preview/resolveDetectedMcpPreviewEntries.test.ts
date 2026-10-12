import { describe, expect, it } from 'vitest';

import type { DetectedMcpServerV1 } from '@happier-dev/protocol';

import { resolveDetectedMcpPreviewEntries } from './resolveDetectedMcpPreviewEntries';

function createDetected(overrides: Partial<DetectedMcpServerV1>): DetectedMcpServerV1 {
  return {
    provider: 'codex',
    name: 'context7',
    transport: 'stdio',
    stdio: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
    envKeys: [],
    enabled: true,
    loadedInHappierSessions: true,
    source: { kind: 'user', path: '/Users/test/.codex/config.toml' },
    ...overrides,
  };
}

describe('resolveDetectedMcpPreviewEntries', () => {
  it('omits native servers whose discovery source declares they are not loaded in Happier sessions', () => {
    expect(resolveDetectedMcpPreviewEntries({
      agentId: 'codex',
      servers: [createDetected({ loadedInHappierSessions: false })],
    })).toEqual([]);
    expect(resolveDetectedMcpPreviewEntries({
      agentId: 'claude',
      servers: [createDetected({ provider: 'claude', loadedInHappierSessions: true })],
    })).toHaveLength(1);
  });
  it('returns read-only preview entries for the selected native backend', () => {
    const entries = resolveDetectedMcpPreviewEntries({
      agentId: 'codex',
      servers: [createDetected({})],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: 'codex',
      sourceKind: 'detected',
      availability: 'readOnly',
      scopeKind: 'providerUser',
      selected: true,
      selectable: false,
      headerKeyCount: 0,
      envKeyCount: 0,
    });
  });

  it('accepts any installed Agent as a detected provider, bundled or externally contributed', () => {
    // 'pi' is inside the former closed detection enum; 'gemini' is a bundled Agent
    // that enum omitted, and 'acme.cli' is an externally contributed Agent id.
    for (const agentId of ['pi', 'gemini', 'acme.cli']) {
      const entries = resolveDetectedMcpPreviewEntries({
        agentId,
        servers: [createDetected({ provider: agentId })],
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        provider: agentId,
        key: `detected:${agentId}:context7`,
      });
    }
  });

  it('uses the higher-precedence project config when multiple detected entries share a name', () => {
    const entries = resolveDetectedMcpPreviewEntries({
      agentId: 'claude',
      servers: [
        createDetected({
          provider: 'claude',
          name: 'playwright',
          source: { kind: 'user', path: '/Users/test/.claude/settings.json' },
          enabled: true,
        }),
        createDetected({
          provider: 'claude',
          name: 'playwright',
          source: { kind: 'project', path: '/repo/.claude/settings.local.json' },
          enabled: false,
        }),
      ],
    });

    expect(entries).toEqual([]);
  });
  it('does not let an unloaded source shadow the same-name server from a loaded source', () => {
    const entries = resolveDetectedMcpPreviewEntries({
      agentId: 'claude',
      servers: [
        createDetected({ provider: 'claude' }),
        createDetected({ provider: 'claude', loadedInHappierSessions: false,
          source: { kind: 'project', path: '/repo/unloaded.json' } }),
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sourcePath).toBe('/Users/test/.codex/config.toml');
  });
});
