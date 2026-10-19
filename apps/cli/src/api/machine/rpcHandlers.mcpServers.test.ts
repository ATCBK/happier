import axios from 'axios';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonMcpServersTestResponseSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import * as executableBoundary from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';

// Only the Home HTTP/cache I/O boundaries are simulated. Reach, materialization,
// the SDK probe and catalog CAS run their production implementations.
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }));
vi.mock('@/api/client/serverHttpBaseUrl', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/serverHttpBaseUrl')>(),
  resolveServerHttpBaseUrl: () => 'https://home.example.test',
}));

const fixture = String.raw`
if (process.env.API_KEY) process.stderr.write(process.env.API_KEY + '\n');
if (process.env.API_KEY?.startsWith('prefix-')) process.stderr.write(process.env.API_KEY.slice('prefix-'.length) + '\n');
if (process.env.API_KEY?.startsWith('Bearer ') && process.env.TOKEN) process.stderr.write(process.env.TOKEN + '\n');
process.stderr.write('Authorization: Bearer fixture-private-token\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? {
    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: 'fixture', version: '2.0.0' }, instructions: 'Read before writing.'
  } : { tools: [{ name: 'read_records', title: 'Read records', description: 'Lists records.',
    annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`;
const server: McpServerCatalogEntryV1 = { id: 'server', name: 'fixture', transport: 'stdio',
  stdio: { command: process.execPath, args: ['-e', fixture] }, env: {}, createdAt: 1, updatedAt: 1 };
const catalog = { v: 1 as const, servers: [server], bindings: [{ id: 'on', serverId: server.id,
  enabled: true, target: { t: 'allMachines' as const }, createdAt: 1, updatedAt: 1 }] };

function register(conflict = false, env: NodeJS.ProcessEnv = process.env) {
  const writes: unknown[] = [];
  vi.mocked(axios.get).mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
    if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: {
      status: 'present', revision: 3, content: { t: 'plain', v: catalog } } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
    throw new Error(`Unexpected HTTP path: ${path}`);
  });
  vi.mocked(axios.post).mockImplementation(async (_url, body) => {
    writes.push(body);
    return { status: conflict ? 409 : 200, data: conflict
      ? { status: 'conflict', revision: 4 } : { status: 'updated', revision: 4, cursor: 1 } };
  });
  const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
  registerMachineMcpServersRpcHandlers({
    rpcHandlerManager: { registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
      handlers.set(method, handler);
    } } as never,
    deps: { env, readCredentials: async () => ({ token: 'rpc-mcp-account', encryption: null }),
      bootstrapAccountSettingsContext: input => bootstrapAccountSettingsContext({ ...input,
        honorAccountSettingsModeEnv: false, deps: { resolveCachePath: resolveAccountSettingsCachePath,
          readCache: async () => null, writeCache: async () => undefined,
          fetchFromServer: async () => ({ settingsVersion: 4, settingsContent: { t: 'plain', v: {} } }),
        } }),
    },
  });
  return { writes, test: async (request: unknown) => DaemonMcpServersTestResponseSchema.parse(
    await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!(request)) };
}

describe('Machine MCP Test pipeline', () => {
  beforeEach(() => { resetInMemoryAccountSettingsContextForTests(); vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset(); });
  afterEach(() => resetInMemoryAccountSettingsContextForTests());

  it('writes metadata and token estimates through the captured catalog CAS', async () => {
    const { test, writes } = register();
    const result = await test({ t: 'byId', serverId: server.id, machineId: 'machine', directory: tmpdir() });
    expect(result).toMatchObject({ ok: true, toolCount: 1, tools: [{ name: 'read_records', title: 'Read records',
      annotations: { readOnlyHint: true }, tokens: 11 }], serverInfo: { name: 'fixture', version: '2.0.0' },
      instructions: 'Read before writing.', protocolVersion: expect.any(String), stderrTail: expect.stringContaining('[REDACTED]') });
    expect(writes).toEqual([expect.objectContaining({ expectedRevision: 3, content: { t: 'plain', v: {
      ...catalog, servers: [{ ...server, updatedAt: expect.any(Number), toolsSnapshot: expect.objectContaining({ machineId: 'machine',
        checkedAt: expect.any(Number), tools: [{ name: 'read_records', title: 'Read records', description: 'Lists records.',
          annotations: { readOnlyHint: true }, tokens: 11 }] }) }],
    } } })]);
    expect(JSON.stringify(result)).not.toContain('fixture-private-token');
  });

  it('refuses a conflicting snapshot CAS without replacing concurrent configuration', async () => {
    const { test, writes } = register(true);
    expect(await test({ t: 'byId', serverId: server.id, machineId: 'machine', directory: tmpdir() }))
      .toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    expect(writes).toHaveLength(1);
  });

  it('reports a missing executable by its configured command', async () => {
    const { test, writes } = register(false, { PATH: '' });
    expect(await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
      ...server, stdio: { command: 'happier-fixture-missing-command', args: [] },
    } })).toMatchObject({ ok: false, errorCode: 'mcp_connect_failed', runtimeMissing: 'happier-fixture-missing-command' });
    expect(writes).toEqual([]);
  });

  it('preserves a missing child executable through the private env/cwd launcher', async () => {
    // Executable selection is the process boundary: this current-source test
    // must not accidentally execute a worker's older packaged launcher.
    const resolveExecutable = executableBoundary.resolveNodeBackedMcpServerCommand;
    const executable = vi.spyOn(executableBoundary, 'resolveNodeBackedMcpServerCommand')
      .mockImplementation(async input => {
        const invocation = await resolveExecutable({ ...input, preferSourceEntrypoint: true });
        return { ...invocation, args: ['--conditions=happier-source', ...invocation.args] };
      });
    try {
      const { test, writes } = register(false, { ...process.env, PATH: '' });
      const result = await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
        ...server, stdio: { command: 'happier-fixture-missing-command', args: [], cwd: { t: 'path', path: tmpdir() } },
        env: { PRIVATE_KEY: { t: 'literal', v: 'synthetic-fixture-private-value' } },
      } });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'mcp_connect_failed', runtimeMissing: 'happier-fixture-missing-command' });
      expect(writes).toEqual([]);
    } finally { executable.mockRestore(); }
  });

  it('redacts bare configured secret bytes before returning child stderr and leaves drafts unpersisted', async () => {
    const { test, writes } = register();
    const result = await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
      ...server, env: { API_KEY: { t: 'literal', v: 'bare-configured-private-value' } },
    } });
    expect(result).toMatchObject({ ok: true, stderrTail: expect.stringContaining('[REDACTED]') });
    expect(JSON.stringify(result)).not.toContain('bare-configured-private-value');
    expect(JSON.stringify(result)).not.toContain('fixture-private-token');
    expect(writes).toEqual([]);
  });

  it('redacts the used template atom when a child echoes it without the rendered prefix', async () => {
    const { test } = register();
    const result = await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
      ...server, env: { API_KEY: { t: 'template', template: 'prefix-{api_key}',
        vars: { api_key: { t: 'literal', v: 'template-atom-private-value' } } } },
    } });
    expect(result).toMatchObject({ ok: true, stderrTail: expect.stringContaining('[REDACTED]') });
    expect(JSON.stringify(result)).not.toContain('template-atom-private-value');
  });

  it('redacts the consumed machine-env atom when a literal expands to a composite value', async () => {
    const { test } = register(false, { ...process.env, TOKEN: 'machine-env-private-atom' });
    const result = await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
      ...server, env: { API_KEY: { t: 'literal', v: 'Bearer ${TOKEN}' } },
    } });
    expect(result).toMatchObject({ ok: true, stderrTail: expect.stringContaining('[REDACTED]') });
    expect(JSON.stringify(result)).not.toContain('machine-env-private-atom');
  });

  it('redacts configured values before the existing stderr tail bound can split them', async () => {
    const { test } = register();
    const result = await test({ t: 'draft', machineId: 'machine', directory: tmpdir(), server: {
      ...server, env: { API_KEY: { t: 'literal', v: 'private-fragment-'.repeat(1100) } },
    } });
    expect(result).toMatchObject({ ok: true, stderrTail: expect.stringContaining('[REDACTED]') });
    expect(JSON.stringify(result)).not.toContain('private-fragment');
  });
});
