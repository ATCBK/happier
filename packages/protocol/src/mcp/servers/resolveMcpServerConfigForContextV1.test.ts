import { describe, expect, it } from 'vitest';
import { McpServerCatalogEntryV1Schema } from './settingsV1.js';
import { resolveMcpServerConfigForContextV1 } from './resolveMcpServerConfigForContextV1.js';

describe('MCP working folder configuration', () => {
  it('applies the machine folder without changing reach', () => {
    const server = McpServerCatalogEntryV1Schema.parse({ id: 'server', name: 'server', transport: 'stdio',
      stdio: { command: 'server', args: [], cwd: { t: 'session' } }, env: {}, createdAt: 1, updatedAt: 1,
      configOverrides: [{ target: { t: 'machine', machineId: 'machine' }, stdio: { cwd: { t: 'path', path: 'C:\\work' } } }],
    });
    const context = { machineId: 'machine', directory: 'C:\\session', machinePlatform: 'win32' as const,
      projectKey: null, agentId: null };
    expect(resolveMcpServerConfigForContextV1(server, context).stdio?.cwd).toEqual({ t: 'path', path: 'C:\\work' });
    expect(McpServerCatalogEntryV1Schema.safeParse({ ...server, configOverrides: [{
      target: { t: 'machine', machineId: 'machine' }, stdio: { cwd: { t: 'session' } },
    }] }).success).toBe(false);
  });
});
