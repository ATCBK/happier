import { describe, expect, it } from 'vitest';
import { McpServerCatalogEntryV1Schema } from './settingsV1.js';
import { resolveMcpServerConfigForContextV1 } from './resolveMcpServerConfigForContextV1.js';

describe('MCP working folder configuration', () => {
  it('replaces the base URL template when a machine specifies another URL', () => {
    const server = McpServerCatalogEntryV1Schema.parse({ id: 'server', name: 'server', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: {}, urlTemplate: {
        t: 'template', template: 'https://example.test/{tenant}/mcp', vars: { tenant: { t: 'literal', v: 'account' } },
      } }, env: {}, createdAt: 1, updatedAt: 1, configOverrides: [
        { target: { t: 'machine', machineId: 'machine' }, remote: { url: 'https://other.example.test/mcp' } },
      ] });
    const context = { machineId: 'machine', directory: '/repo', machinePlatform: null, projectKey: null, agentId: null };
    expect(resolveMcpServerConfigForContextV1(server, context).remote).toEqual({ url: 'https://other.example.test/mcp', headers: {} });
    expect(resolveMcpServerConfigForContextV1(server, { ...context, machineId: 'another' }).remote).toEqual(server.remote);
  });
  it.each([{ t: 'path' as const, path: 'C:\\work' }, { t: 'session' as const }])('applies the machine folder %j without changing other machines', (cwd) => {
    const server = McpServerCatalogEntryV1Schema.parse({ id: 'server', name: 'server', transport: 'stdio',
      stdio: { command: 'server', args: [], cwd: { t: 'path', path: 'C:\\base' } }, env: {}, createdAt: 1, updatedAt: 1,
      configOverrides: [{ target: { t: 'machine', machineId: 'machine' }, stdio: { cwd } }],
    });
    const context = { machineId: 'machine', directory: 'C:\\session', machinePlatform: 'win32' as const,
      projectKey: null, agentId: null };
    expect(resolveMcpServerConfigForContextV1(server, context).stdio?.cwd).toEqual(cwd);
    expect(resolveMcpServerConfigForContextV1(server, { ...context, machineId: 'another' }).stdio).toEqual(server.stdio);
  });
});
