import { describe, expect, it } from 'vitest';
import { McpServerCatalogEntryV1Schema, McpServerConfigOverrideFieldsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { applyMcpServerConfigOverrideV1 } from '@happier-dev/protocol/mcp/servers/resolveMcpServerConfigForContextV1';

import { diffMcpServerConfigOverride } from './mcpMachineOverride';

const local = McpServerCatalogEntryV1Schema.parse({
  id: 'pg-1', name: 'postgres', transport: 'stdio', createdAt: 1, updatedAt: 1,
  stdio: { command: 'npx', args: ['-y', 'pg-mcp@1.0.0'], cwd: { t: 'session' } },
  env: { DATABASE_URL: { t: 'literal', v: 'postgres://base' }, DEBUG: { t: 'literal', v: '1' } },
});
const remote = McpServerCatalogEntryV1Schema.parse({
  id: 'gh-1', name: 'github', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://api.example.com/mcp', headers: { Authorization: { t: 'savedSecret', secretId: 'secret-1' } } },
});

describe('diffMcpServerConfigOverride', () => {
  it('stores a session-folder override when a machine resets a fixed base folder', () => {
    const base = { ...local, stdio: { ...local.stdio!, cwd: { t: 'path' as const, path: '/base-folder' } } };
    const edited = { ...base, stdio: { ...base.stdio, cwd: { t: 'session' as const } } };
    expect(McpServerConfigOverrideFieldsV1Schema.safeParse({ stdio: { cwd: edited.stdio.cwd } }).success).toBe(true);
    const override = diffMcpServerConfigOverride(base, edited);
    expect(override).toEqual({ stdio: { cwd: { t: 'session' } } });
    const stored = McpServerConfigOverrideFieldsV1Schema.parse(JSON.parse(JSON.stringify(override)));
    expect(applyMcpServerConfigOverrideV1(base, stored).stdio?.cwd).toEqual({ t: 'session' });
    expect(McpServerConfigOverrideFieldsV1Schema.safeParse({ stdio: { cwd: { t: 'session', path: '/ignored' } } }).success).toBe(false);
  });
  it('treats an absent folder and an explicit session folder as the same effective choice', () => {
    const { cwd: _cwd, ...stdio } = local.stdio!;
    const implicit = { ...local, stdio };
    expect(diffMcpServerConfigOverride(implicit, local)).toBeUndefined();
    expect(diffMcpServerConfigOverride(local, implicit)).toBeUndefined();
    const base = { ...local, stdio: { ...stdio, cwd: { t: 'path' as const, path: '/base-folder' } } };
    expect(diffMcpServerConfigOverride(base, implicit)).toEqual({ stdio: { cwd: { t: 'session' } } });
  });
  it('is nothing when the machine matches the base configuration', () => {
    expect(diffMcpServerConfigOverride(local, local)).toBeUndefined();
    expect(diffMcpServerConfigOverride(remote, remote)).toBeUndefined();
  });

  it('refuses an override that cannot be stored instead of returning an invalid change', () => {
    expect(() => diffMcpServerConfigOverride(local, { ...local, stdio: { ...local.stdio!, command: '' } })).toThrow();
  });

  it('keeps only what differs, and applying it restores the edited configuration', () => {
    const edited = { ...local,
      stdio: { command: 'npx', args: ['-y', 'pg-mcp@1.1.0'], cwd: { t: 'path' as const, path: '/srv/db' } },
      env: { DATABASE_URL: { t: 'literal' as const, v: 'postgres://nl2' }, DEBUG: local.env.DEBUG! } };
    const override = diffMcpServerConfigOverride(local, edited);
    expect(override).toEqual({
      stdio: { args: ['-y', 'pg-mcp@1.1.0'], cwd: { t: 'path', path: '/srv/db' } },
      envPatch: { DATABASE_URL: { t: 'literal', v: 'postgres://nl2' } },
    });
    expect(McpServerConfigOverrideFieldsV1Schema.safeParse(override).success).toBe(true);
    expect(applyMcpServerConfigOverrideV1(local, override)).toEqual({ ...local, ...edited });
  });

  it('removes a variable or header the machine does not have with an explicit null', () => {
    const noDebug = diffMcpServerConfigOverride(local, { ...local, env: { DATABASE_URL: local.env.DATABASE_URL! } });
    expect(noDebug).toEqual({ envPatch: { DEBUG: null } });
    const noAuth = diffMcpServerConfigOverride(remote, { ...remote, remote: { ...remote.remote!, headers: {} } });
    expect(noAuth).toEqual({ remote: { headersPatch: { Authorization: null } } });
    expect(applyMcpServerConfigOverrideV1(remote, noAuth).remote?.headers).toEqual({});
  });

  it('carries a different address and a header added on one machine', () => {
    const edited = { ...remote, remote: { ...remote.remote!, url: 'https://eu.example.com/mcp',
      headers: { ...remote.remote!.headers, 'X-Region': { t: 'literal' as const, v: 'eu' } } } };
    const override = diffMcpServerConfigOverride(remote, edited);
    expect(override).toEqual({ remote: { url: 'https://eu.example.com/mcp', headersPatch: { 'X-Region': { t: 'literal', v: 'eu' } } } });
    expect(applyMcpServerConfigOverrideV1(remote, override)).toEqual(edited);
  });
});
