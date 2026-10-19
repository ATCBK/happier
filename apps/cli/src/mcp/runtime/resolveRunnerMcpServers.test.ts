import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { accountSettingsParse, FeaturesResponseSchema, formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1, type McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import { getActiveProjectAccountRowsSnapshot, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import * as persistence from '@/persistence';
import type { HappyMcpSessionClient } from '../startHappyServer';
import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';
import type { McpRequestAuthPort } from './mcpRequestAuth';
import { McpServerCatalogV1Schema, projectStoredMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { diffMcpServerConfigOverride } from '../../../../ui/sources/components/settings/mcpServers/detail/mcpMachineOverride';
import { logger } from '@/ui/logger';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

// The daemon catalog is an IPC boundary. Runtime, bridge, selectors and
// materialization remain real, including the local HTTP listener lifecycle.
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetActiveAccountSettingsSnapshotForTests(); withdrawActiveProjectAccountRowsSnapshot(); });
const credentials = { token: 'runner-account', encryption: null };
function server(id: string): McpServerCatalogEntryV1 {
  return { id, name: id, transport: 'stdio', stdio: { command: 'echo', args: [id] }, env: {}, createdAt: 1, updatedAt: 1 };
}
function snapshot(servers: McpServerCatalogEntryV1[] = []): ActiveAccountSettingsSnapshot {
  return { source: 'network', settings: accountSettingsParse({ mcpServersStrictMode: true }),
    rawSettings: {}, settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
    mcpServerCatalog: { status: 'ready', authority: 'active', revision: 2, diagnostics: [],
      catalog: { v: 1, servers, bindings: servers.map(entry => ({ id: `binding-${entry.id}`, serverId: entry.id,
        enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 })) } } };
}
function session(): HappyMcpSessionClient & Required<Pick<HappyMcpSessionClient, 'enqueueSessionEventCommitted'>> {
  return { sessionId: 'session-1', getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'session-1', encryptionMode: 'plain' }),
    updateMetadata: () => undefined,
    enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }) };
}
function resolve(input: Readonly<{ snapshot: ActiveAccountSettingsSnapshot | null; accountSettings?: ActiveAccountSettingsSnapshot['settings']; accountCredentials?: null; includeHappierMcpServer?: boolean }>) {
  vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
  return resolveRunnerMcpServers({ session: session(), credentials,
    ...(input.accountCredentials === null ? { accountCredentials: null } : {}),
    accountSettings: input.accountSettings ?? input.snapshot?.settings ?? accountSettingsParse({}), accountSettingsSnapshot: input.snapshot,
    machineId: 'machine-1', directory: '/tmp/repo', env: {}, tmpDir: null,
    includeHappierMcpServer: input.includeHappierMcpServer });
}

describe('resolveRunnerMcpServers catalog admission', () => {
  it('applies the editor session-folder difference after catalog storage on only the selected machine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-session-folder-'));
    const base = { ...server('local'), stdio: { command: 'echo', args: ['base'], cwd: { t: 'path' as const, path: '/base-folder' } } };
    const edited = { ...base, stdio: { ...base.stdio, cwd: { t: 'session' as const } } };
    const difference = diffMcpServerConfigOverride(base, edited);
    const captured = snapshot([{ ...base, configOverrides: [{ ...difference, target: { t: 'machine', machineId: 'machine-1' } }] }]);
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Expected ready catalog');
    const written = McpServerCatalogV1Schema.parse(captured.mcpServerCatalog.catalog);
    // The stored reader remains tolerant; current writes above use the strict schema.
    const stored = projectStoredMcpServerCatalogV1(JSON.parse(JSON.stringify({ ...written, futureField: true,
      servers: written.servers.map(entry => ({ ...entry, futureField: true })),
    })));
    expect(stored.status).toBe('opened');
    if (stored.status !== 'opened') throw new Error('Expected stored catalog');
    const restored: ActiveAccountSettingsSnapshot = { ...captured,
      mcpServerCatalog: { ...captured.mcpServerCatalog, catalog: stored.catalog } };
    try {
      for (const machineId of ['machine-1', 'machine-2']) {
        const result = await resolveRunnerMcpServers({ session: session(), credentials,
          accountSettings: restored.settings, accountSettingsSnapshot: restored, machineId, directory: '/session-folder',
          env: {}, tmpDir: root, includeHappierMcpServer: false,
        });
        try {
          const configPath = result.mcpServers.local?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
          expect(configPath).toBeDefined();
          expect(JSON.parse(await readFile(configPath!, 'utf8'))).toMatchObject({
            command: 'echo', args: ['base'], cwd: machineId === 'machine-1' ? '/session-folder' : '/base-folder',
          });
        } finally { result.happierMcpServer.stop(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['zero-rules', 'another-machine', 'another-agent'] as const)('materializes a Session include with %s while keeping unsupported Agent refusal', async scenario => {
    const captured = snapshot([server('included')]);
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Missing catalog');
    captured.mcpServerCatalog.catalog.bindings = scenario === 'zero-rules' ? [] : [{
      ...captured.mcpServerCatalog.catalog.bindings[0]!,
      ...(scenario === 'another-machine' ? { target: { t: 'machine', machineId: 'other' } as const } : { agentId: 'gemini' }),
    }];
    const input = { session: session(), credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/repo', agentId: 'codex', agentAcceptsUserMcp: true,
      sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['included'], forceExcludeServerIds: [] } },
      includeHappierMcpServer: false as const };
    const result = await resolveRunnerMcpServers(input);
    try { expect(Object.keys(result.mcpServers)).toEqual(['included']); }
    finally { result.happierMcpServer.stop(); }
    const unsupported = await resolveRunnerMcpServers({ ...input, agentAcceptsUserMcp: false });
    try { expect(unsupported.mcpServers).toEqual({}); }
    finally { unsupported.happierMcpServer.stop(); }
  });
  it.each([false, true])('keeps reach independent from machine cwd/env overrides (Everywhere On=%s)', async enabled => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-machine-config-'));
    const captured = snapshot([{ ...server('local'), stdio: { command: 'echo', args: ['base'], cwd: { t: 'session' } },
      env: { REGION: { t: 'literal', v: 'base' } }, configOverrides: [{
        target: { t: 'machine', machineId: 'machine-1' }, stdio: { cwd: { t: 'path', path: '~\\custom\\mcp' } },
        envPatch: { REGION: { t: 'literal', v: 'machine' } },
      }],
    }]);
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Expected ready catalog');
    captured.mcpServerCatalog.catalog.bindings[0]!.enabled = enabled;
    const result = await resolveRunnerMcpServers({ session: session(), credentials,
      accountSettings: captured.settings, accountSettingsSnapshot: captured, machineId: 'machine-1', directory: '/repo',
      env: { HOME: root, USERPROFILE: root }, tmpDir: root, includeHappierMcpServer: false,
    });
    try {
      if (!enabled) expect(result.mcpServers).toEqual({});
      else {
        expect(result.mcpServers.local?.env).not.toHaveProperty('REGION');
        const path = result.mcpServers.local?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
        expect(path).toBeDefined();
        expect(JSON.parse(await readFile(path!, 'utf8'))).toMatchObject({
          command: 'echo', args: ['base'], cwd: join(root, 'custom', 'mcp'), env: { REGION: 'machine' },
        });
      }
    } finally { result.happierMcpServer.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it('resolves Project rules once before materializing and refuses an unreadable association', async () => {
    const base = snapshot([server('tools')]);
    if (base.mcpServerCatalog?.status !== 'ready') throw new Error('Expected ready catalog');
    const projectCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'mcp-project-account' })).toString('base64url')}.signature`, encryption: null };
    const serverHttpBaseUrl = session().getServerBinding().serverUrl;
    const captured = { ...base, mcpServerCatalog: { ...base.mcpServerCatalog, catalog: { ...base.mcpServerCatalog.catalog,
      bindings: base.mcpServerCatalog.catalog.bindings.map(rule => ({ ...rule, target: { t: 'project' as const, projectKey: 'project' } })),
    } }, scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(projectCredentials.token)) };
    const operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials: projectCredentials, snapshot: captured, serverHttpBaseUrl, isCurrent: async () => true,
    }));
    const serverId = session().getServerBinding().serverId;
    const key = { kind: 'workspace-ref', serverId, id: 'checkout' };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
    const request = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
      { key, revision: 1, content: { t: 'plain', v: { key, value: { id: 'checkout', serverId, machineId: 'machine-1',
        rootPath: '/repo', projectKey: 'project', createdAtMs: 1 } } } },
    ] } });
    const input = { session: session(), credentials: projectCredentials, accountSettings: captured.settings, accountSettingsSnapshot: captured, operationContext,
      machineId: 'machine-1', directory: '/repo', agentId: 'codex', agentAcceptsUserMcp: true,
      sessionMetadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' }, includeHappierMcpServer: false as const };
    const result = await resolveRunnerMcpServers(input);
    try {
      expect(Object.keys(result.mcpServers)).toEqual(['tools']);
      expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
    } finally { result.happierMcpServer.stop(); }
    expect(request.mock.calls.filter(call => call[0].endsWith(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`))).toHaveLength(1);
    request.mockRejectedValue(new Error('network_unavailable'));
    await expect(resolveRunnerMcpServers(input)).rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_association_unavailable' });
    request.mockClear();
    const unsupported = await resolveRunnerMcpServers({ ...input, agentAcceptsUserMcp: false });
    try { expect(Object.keys(unsupported.mcpServers)).toEqual([]); } finally { unsupported.happierMcpServer.stop(); }
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    ['mcp_catalog_unavailable', 'mcp_catalog_unavailable', 'mcp_catalog_unavailable'],
    ['mcp_resource_mismatch', 'mcp_resource_mismatch', 'mcp_resource_mismatch'],
    ['native_agent_privileged_effect_authority_unavailable', 'mcp_request_auth_unavailable', 'native_agent_privileged_effect_authority_unavailable'],
    ['native_agent_privileged_effect_outcome_unknown', 'mcp_request_auth_unavailable', 'native_agent_privileged_effect_outcome_unknown'],
    ['native_agent_privileged_effect_authority_unavailable', 'mcp_request_auth_unavailable', 'agent_runtime_daemon_service_forbidden', 'daemon_service_dispatch', 'agent_runtime_daemon_service_forbidden'],
    ['untrusted exception with private connection details', 'mcp_request_auth_unavailable', 'mcp_request_auth_unavailable'],
  ])('keeps other servers available and reports a safe refusal when OAuth admission fails (%s)', async (failure, detail, failureCode, failureCheckpoint = 'request_auth_open', causeCode?: string) => {
    const warnings = vi.spyOn(logger, 'debug');
    const notices: unknown[] = [];
    const captured = snapshot([server('static'), { id: 'oauth', name: 'oauth', transport: 'http', remote: { url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const nonStrict = { ...captured, settings: accountSettingsParse({ mcpServersStrictMode: false }) };
    const result = await resolveRunnerMcpServers({ session: { ...session(),
      enqueueSessionEventCommitted: async event => { notices.push(event); return { persisted: true, delivered: true }; },
      getMcpRequestAuthPort: () => ({
      open: async () => { throw new Error(failure, causeCode ? { cause: { code: causeCode, stage: 'dispatch' } } : undefined); }, close: async () => undefined,
    }) }, credentials, accountSettings: nonStrict.settings, accountSettingsSnapshot: nonStrict,
    machineId: 'machine-1', directory: '/repo', tmpDir: null, includeHappierMcpServer: false });
    try {
      expect(Object.keys(result.mcpServers)).toEqual(['static']);
      expect(warnings.mock.calls).toContainEqual(['[mcp] Materialization warnings', {
        warningCount: 1, warnings: [{ serverName: 'oauth', code: 'invalid_server', detail,
          failureCode, failureCheckpoint }],
      }]);
      expect(JSON.stringify(notices)).not.toContain('failureCheckpoint');
      expect(JSON.stringify(notices)).not.toContain('native_agent_privileged_effect');
      expect(JSON.stringify(warnings.mock.calls)).not.toContain('private connection details');
    } finally { result.happierMcpServer.stop(); }
  });
  it('uses the materializer refusal for strict OAuth admission without exposing the port exception', async () => {
    const captured = snapshot([{ id: 'oauth', name: 'oauth', transport: 'http', remote: {
      url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' },
    }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const notices: unknown[] = [];
    await expect(resolveRunnerMcpServers({ session: { ...session(),
      enqueueSessionEventCommitted: async event => { notices.push(event); return { persisted: true, delivered: true }; },
      getMcpRequestAuthPort: () => ({
        open: async () => { throw Object.assign(new Error('private credential transport response'), { code: 'mcp_request_auth_unavailable' }); },
        close: async () => {},
      }),
    }, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
    machineId: 'machine-1', directory: '/repo', includeHappierMcpServer: false })).rejects.toThrow(/^mcp_request_auth_unavailable$/);
    expect(notices).toEqual([]);
  });
  it('opens a per-server OAuth capability through the admitted Session port and closes it with the MCP profile', async () => {
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    let elapsedMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    const resource = 'https://mcp.example.test/path';
    const captured = snapshot([{ id: 'oauth', name: 'oauth', transport: 'http', remote: { url: resource, headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-runner-auth-'));
    const opened: Array<Parameters<import('./mcpRequestAuth').McpRequestAuthPort['open']>[0]> = [];
    const closed: string[] = [];
    // The authenticated daemon channel is the system boundary; runner selection and materialization stay real.
    const port: import('./mcpRequestAuth').McpRequestAuthPort = {
      async open(input) { opened.push(input); elapsedMs += 700; return { capabilityFile: join(root, 'capability.json'), resource }; },
      async close(input) { closed.push(input.materializationId); },
    };
    let resolved: Awaited<ReturnType<typeof resolveRunnerMcpServers>> | undefined;
    try {
      resolved = await resolveRunnerMcpServers({
        session: { ...session(), getMcpRequestAuthPort: () => port }, credentials,
        accountSettings: captured.settings, accountSettingsSnapshot: captured, machineId: 'machine-1', directory: '/repo', tmpDir: root,
        includeHappierMcpServer: false,
      });
      expect(opened).toHaveLength(1);
      const phases = diagnostics.mock.calls.flatMap(([message, fields]) => message === '[mcp] Startup phase'
        && fields && typeof fields === 'object' ? [fields as Record<string, unknown>] : []);
      expect(phases).toContainEqual(expect.objectContaining({ sessionId: 'session-1', phase: 'request_auth', durationMs: 700, elapsedMs: 700 }));
      expect(phases).toContainEqual(expect.objectContaining({ phase: 'config_materialization', durationMs: 0, elapsedMs: 700 }));
      expect(JSON.stringify(phases)).not.toContain(resource);
      expect(JSON.stringify(phases)).not.toContain(root);
      expect(opened[0]).toMatchObject({ serverId: 'oauth', resource });
      const config = JSON.parse(await readFile(resolved.mcpServers.oauth!.env!.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE!, 'utf8'));
      expect(config.auth).toEqual({ capabilityFile: join(root, 'capability.json'), resource });
      resolved.happierMcpServer.stop();
      expect(closed).toEqual([opened[0]!.materializationId]);
    } finally { resolved?.happierMcpServer.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it('refuses unregistered Run OAuth occurrences before capability open even in non-strict mode', async () => {
    const captured = snapshot([{ id: 'oauth', name: 'oauth', transport: 'http', remote: {
      url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' },
    }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const open = vi.fn<McpRequestAuthPort['open']>();
    await expect(resolveRunnerMcpServers({
      session: { ...session(), getMcpRequestAuthPort: () => ({ open, close: async () => {} }) }, credentials,
      accountSettings: accountSettingsParse({ mcpServersStrictMode: false }), accountSettingsSnapshot: {
        ...captured, settings: accountSettingsParse({ mcpServersStrictMode: false }),
      }, machineId: 'machine-1', directory: '/repo', includeHappierMcpServer: false,
      executionRun: { runId: 'unregistered-run', workDepth: 0, cwd: '/repo', signal: new AbortController().signal,
        isCurrent: () => true, readActiveTurnAdmissionWitness: () => null, readCurrentRunOccurrence: () => null },
    })).rejects.toThrow('mcp_request_auth_not_active');
    expect(open).not.toHaveBeenCalled();
  });
  it.each([false, true])('joins independent OAuth issuances before materialization or strict failure (refused=%s)', async refused => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-parallel-auth-'));
    const captured = snapshot(['first', 'second', 'third'].map(id => ({ id, name: id, transport: 'http',
      remote: { url: `https://${id}.example.test/mcp`, headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 })));
    const started: string[] = [];
    const closed: string[] = [];
    const pending = new Map<string, ReturnType<typeof createDeferred<void>>>();
    let released = false;
    let settled = false;
    let resolved: Awaited<ReturnType<typeof resolveRunnerMcpServers>> | undefined;
    const port: McpRequestAuthPort = {
      async open(input) {
        started.push(input.serverId);
        const gate = createDeferred<void>();
        pending.set(input.serverId, gate);
        if (!released) await gate.promise;
        if (refused && input.serverId === 'first') throw new Error('mcp_resource_mismatch');
        return { capabilityFile: join(root, `${input.serverId}.json`), resource: input.resource };
      },
      async close(input) { closed.push(input.materializationId); },
    };
    const work = resolveRunnerMcpServers({ session: { ...session(), getMcpRequestAuthPort: () => port }, credentials,
      accountSettings: captured.settings, accountSettingsSnapshot: captured, machineId: 'machine-1', directory: '/repo', tmpDir: root,
      includeHappierMcpServer: false }).then(value => { resolved = value; settled = true; return value; }, error => { settled = true; throw error; });
    // Retain the failure until all independently issued capabilities settle.
    const outcome = work.then(() => null, error => error);
    try {
      await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
      expect(started).toEqual(['first', 'second', 'third']);
      pending.get('first')!.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      pending.get('third')!.resolve();
      pending.get('second')!.resolve();
      if (refused) {
        await expect(outcome).resolves.toMatchObject({ message: 'mcp_resource_mismatch' });
        expect(closed).toHaveLength(2);
      } else {
        expect(await outcome).toBeNull();
        for (const id of started) {
          const config = JSON.parse(await readFile(resolved!.mcpServers[id]!.env!.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE!, 'utf8'));
          expect(config.auth).toEqual({ capabilityFile: join(root, `${id}.json`), resource: `https://${id}.example.test/mcp` });
        }
        resolved!.happierMcpServer.stop();
        expect(closed).toHaveLength(3);
      }
    } finally {
      released = true;
      for (const gate of pending.values()) gate.resolve();
      await outcome;
      resolved?.happierMcpServer.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('measures OAuth preparation through the real materializer with independent daemon latency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-auth-timing-'));
    const captured = snapshot(['first', 'second', 'third'].map(id => ({ id, name: id, transport: 'http',
      remote: { url: `https://${id}.example.test/mcp`, headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 })));
    let active = 0;
    let peak = 0;
    const port: McpRequestAuthPort = { async open(input) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 40));
      active -= 1;
      return { capabilityFile: join(root, `${input.serverId}.json`), resource: input.resource };
    }, close: async () => {} };
    let result: Awaited<ReturnType<typeof resolveRunnerMcpServers>> | undefined;
    const startedAt = performance.now();
    try {
      result = await resolveRunnerMcpServers({ session: { ...session(), getMcpRequestAuthPort: () => port }, credentials,
        accountSettings: captured.settings, accountSettingsSnapshot: captured, machineId: 'machine-1', directory: '/repo', tmpDir: root,
        includeHappierMcpServer: false });
      console.info('PERF4 OAuth preparation measurement', { durationMs: Math.round(performance.now() - startedAt), peak, servers: Object.keys(result.mcpServers).length });
      expect(Object.keys(result.mcpServers)).toEqual(['first', 'second', 'third']);
      expect(peak).toBe(3);
    } finally { result?.happierMcpServer.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it('materializes selected user servers without a built-in bridge for extension delivery and releases their files', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const captured = snapshot([
      { ...server('selected'), env: { USER_VALUE: { t: 'literal', v: 'materialized-value' } } },
      server('excluded'),
      { id: 'remote', name: 'remote', transport: 'http',
        remote: { url: 'https://remote.example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 },
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'happier-extension-runner-'));
    // An OS listener spy distinguishes user-only resolution from starting a bridge.
    const listen = vi.spyOn(Server.prototype, 'listen');
    const resolved = await resolveRunnerMcpServers({
      session: session(), credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/repo', env: {}, tmpDir: dir,
      sessionMetadata: { mcpSelectionV1: { v: 1, forceExcludeServerIds: ['excluded'] } },
      includeHappierMcpServer: false,
    });
    const configPath = resolved.mcpServers.remote?.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE;
    try {
      expect(Object.keys(resolved.mcpServers).sort()).toEqual(['remote', 'selected']);
      expect(JSON.stringify(resolved.mcpServers.selected)).not.toContain('materialized-value');
      const selectedPath = resolved.mcpServers.selected?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
      expect(selectedPath).toBeDefined();
      expect(JSON.parse(await readFile(selectedPath!, 'utf8')).env).toEqual({ USER_VALUE: 'materialized-value' });
      expect(listen).not.toHaveBeenCalled();
      expect(configPath).toBeDefined();
      expect(JSON.parse(await readFile(configPath!, 'utf8')).url).toBe('https://remote.example.test/mcp');
    } finally {
      resolved.happierMcpServer.stop();
      if (configPath) await expect(stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([true, false])('publishes skipped-server notices with built-in bridge delivery %s', async (includeHappierMcpServer) => {
    const captured = { ...snapshot([
      { ...server('linear'), env: { LINEAR_API_KEY: { t: 'literal' as const, v: '${LINEAR_API_KEY}' } } },
      server('docs'),
    ]), settings: accountSettingsParse({ mcpServersStrictMode: false }) };
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Missing catalog');
    captured.mcpServerCatalog.catalog.bindings = captured.mcpServerCatalog.catalog.bindings.filter(rule => rule.serverId !== 'linear');
    const enqueueSessionEventCommitted = vi.fn<NonNullable<HappyMcpSessionClient['enqueueSessionEventCommitted']>>(async () => ({ persisted: true, delivered: true }));
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const resolved = await resolveRunnerMcpServers({
      session: { ...session(), enqueueSessionEventCommitted }, credentials,
      accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/tmp/repo', env: {},
      agentId: 'codex', agentAcceptsUserMcp: true,
      sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['linear'], forceExcludeServerIds: [] } },
      includeHappierMcpServer,
    });
    try {
      expect(resolved.mcpServers.linear).toBeUndefined();
      expect(resolved.mcpServers.docs).toBeDefined();
      expect(readSessionCapabilityNoticeV1(enqueueSessionEventCommitted.mock.calls[0]?.[0])).toMatchObject({
        items: [{ kind: 'mcp_server', itemId: 'linear', code: 'missing_value_ref' }],
      });
      expect(enqueueSessionEventCommitted.mock.calls).toEqual([[expect.objectContaining({
        type: 'message', message: expect.stringContaining('linear'),
        capabilityNoticeV1: { v: 1, items: [{
          kind: 'mcp_server', name: 'linear', itemId: 'linear', code: 'missing_value_ref', detail: 'env:LINEAR_API_KEY',
        }] },
      })]]);
    } finally { resolved.happierMcpServer.stop(); }
  });
  it('does not claim a supplied runtime server was skipped because its Account config could not materialize', async () => {
    const captured = { ...snapshot([
      { ...server('linear'), env: { LINEAR_API_KEY: { t: 'literal' as const, v: '${LINEAR_API_KEY}' } } },
    ]), settings: accountSettingsParse({ mcpServersStrictMode: false }) };
    const enqueueSessionEventCommitted = vi.fn(async () => ({ persisted: true, delivered: true }));
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const supplied = { command: 'echo', args: ['supplied'] };
    const resolved = await resolveRunnerMcpServers({
      session: { ...session(), enqueueSessionEventCommitted }, credentials,
      accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/tmp/repo', env: {}, resolvedMcpServers: { linear: supplied },
    });
    try {
      expect(resolved.mcpServers.linear).toEqual(supplied);
      expect(enqueueSessionEventCommitted.mock.calls).toEqual([]);
    } finally { resolved.happierMcpServer.stop(); }
  });
  it('refuses materialized Account config if its scope retires while publishing a notice', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const serverHttpBaseUrl = session().getServerBinding().serverUrl;
    const captured = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => ({ ...snapshot([
      { ...server('linear'), env: { LINEAR_API_KEY: { t: 'literal' as const, v: '${LINEAR_API_KEY}' } } },
      server('docs'),
    ]), settings: accountSettingsParse({ mcpServersStrictMode: false }) }));
    setActiveAccountSettingsSnapshot(captured);
    const admittedSnapshot = getActiveAccountSettingsSnapshot();
    if (!admittedSnapshot) throw new Error('Expected admitted Account snapshot');
    const pending = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveRunnerMcpServers({
      session: { ...session(), enqueueSessionEventCommitted: async () => {
        clearActiveAccountSettingsSnapshot();
        return { persisted: true, delivered: true };
      } }, credentials, accountSettings: admittedSnapshot.settings, accountSettingsSnapshot: admittedSnapshot,
      machineId: 'machine-1', directory: '/tmp/repo', env: {},
    })).then(result => { result.happierMcpServer.stop(); return result; });
    await expect(pending).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'scope-retired' });
  });
  it('uses the Session owner snapshot for attested headers, never launch hints or environment', async () => {
    const captured = snapshot([{ id: 'wilson', name: 'wilson', transport: 'http',
      remote: { url: 'https://wilson.example.test/mcp', headers: {
        'X-Wilson-On-Behalf-Of': { t: 'sessionAttested', field: 'externalPrincipalId' },
        'X-Wilson-Source-Message': { t: 'sessionAttested', field: 'sourceMessageId' },
        'X-Happier-Session': { t: 'sessionAttested', field: 'sessionId' },
      } }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const dir = await mkdtemp(join(tmpdir(), 'happier-attested-runner-'));
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const resolved = await resolveRunnerMcpServers({
      session: { ...session(), getMetadataSnapshot: () => createTestMetadata({ attestedContext: {
        externalPrincipalId: 'sales@batiplus.ch', sourceMessageId: '<lead@example.test>',
      } }) }, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/repo', env: { externalPrincipalId: 'forged-env' }, tmpDir: dir,
      sessionMetadata: { attestedContext: { externalPrincipalId: 'forged-hint', sourceMessageId: 'forged' } },
    });
    try {
      const configPath = resolved.mcpServers.wilson.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE;
      const config = JSON.parse(await readFile(configPath!, 'utf8'));
      expect(config.headers).toEqual({ 'X-Wilson-On-Behalf-Of': 'sales@batiplus.ch',
        'X-Wilson-Source-Message': '<lead@example.test>', 'X-Happier-Session': 'session-1' });
    } finally { resolved.happierMcpServer.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it('returns identities from the actual selected and materialized catalog entries', async () => {
    const captured = snapshot([{ ...server('docs'), updatedAt: 10 }]);
    if (captured.mcpServerCatalog?.status !== 'ready') throw new Error('Expected ready fixture');
    captured.mcpServerCatalog.catalog.bindings[0]!.updatedAt = 20;
    const resolved = await resolve({ snapshot: captured });
    try {
      expect(resolved.mcpServerIdentities).toEqual({ docs: {
        serverId: 'docs', serverTitle: 'docs', usage: { serverId: 'docs', bindingId: 'binding-docs', serverRevision: 10, bindingRevision: 20, catalogRevision: 2 },
      } });
      expect(resolved.mcpServers.docs).toBeDefined();
    } finally { resolved.happierMcpServer.stop(); }
  });
  it('refuses ordinary Account material after retirement while the real bridge listener is starting', async () => {
    // Credential disk I/O is the persistence boundary used by ordinary Home
    // admission; it supplies the same credentials as the real active owner.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const serverHttpBaseUrl = session().getServerBinding().serverUrl;
    const resourceId = 'ordinary-private';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content: {
      v: 1, name: 'Ordinary private credential', kind: 'token', value: 'ordinary-private-value',
    } });
    const capturedSource = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => snapshot([{ ...server('private-server'),
      env: { API_KEY: { t: 'savedSecret', secretId: ref } } }]));
    setActiveAccountSettingsSnapshot({ ...capturedSource, savedSecretCatalogState: 'ready', savedSecretResources: [{
      resourceId, ownerAccountId: 'ordinary-owner', displayName: 'Ordinary private credential', kind: 'token',
      encryptionMode: 'plain', revision: 1, materialStatus: 'ready', storedContent,
    }] });
    const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true,
      credentialResources: { enabled: true } } }, capabilities: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200 })));
    const materials = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId,
      encryptionMode: 'plain', entry: { ref, source: 'shared_resource', relationship: 'owner',
        name: 'Ordinary private credential', kind: 'token', ownerAccountId: 'ordinary-owner', revision: 1,
        materialStatus: 'ready', capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
      storedContent, recipientEnvelope: null,
    }] });
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      if (!String(input).endsWith('/v1/account/saved-secrets/resources/materials')) throw new Error('Unexpected Home request');
      return { status: 200, data: materials };
    });
    const captured = getActiveAccountSettingsSnapshot();
    if (!captured) throw new Error('Account fixture is unavailable');
    const listenerStarted = createDeferred<void>();
    const releaseListener = createDeferred<void>();
    let listener: Server | undefined;
    const emit = Server.prototype.emit;
    // The HTTP listener's OS completion is held; the real bridge, command
    // resolution, Account owner and SavedSecret materializer remain unmocked.
    vi.spyOn(Server.prototype, 'emit').mockImplementation(function (this: Server, event: string | symbol, ...args: unknown[]) {
      if (event !== 'listening') return emit.call(this, event, ...args);
      listener = this;
      listenerStarted.resolve();
      void releaseListener.promise.then(() => emit.call(this, event, ...args));
      return true;
    });
    const pending = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolve({ snapshot: captured }));
    void pending.catch(() => undefined);
    try {
      await Promise.race([listenerStarted.promise, pending.then(() => { throw new Error('Bridge did not reach its listener boundary'); })]);
      clearActiveAccountSettingsSnapshot();
      setActiveAccountSettingsSnapshot(runWithServerHttpBaseUrl(serverHttpBaseUrl, () => snapshot([server('replacement-server')])));
      releaseListener.resolve();
      await expect(pending).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'scope-retired' });
    } finally {
      releaseListener.resolve();
      await pending.then(result => result.happierMcpServer.stop(), () => undefined);
      if (listener?.listening) await new Promise<void>((resolveClose, rejectClose) => listener!.close(error => error ? rejectClose(error) : resolveClose()));
    }
  });

  it('materializes the admitted row after the authored root has been removed', async () => {
    const result = await resolve({ snapshot: snapshot([server('row-server')]) });
    try { expect(Object.keys(result.mcpServers).sort()).toEqual(['happier', 'row-server']); }
    finally { result.happierMcpServer.stop(); }
  });

  it('refuses unobserved and partial catalogs when strict MCP policy requires them', async () => {
    setActiveAccountSettingsSnapshot(snapshot([server('ambient-server')]));
    await expect(resolve({ snapshot: null, accountSettings: accountSettingsParse({ mcpServersStrictMode: true }) }))
      .rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'catalog-unobserved' });
    const opened = snapshot([server('valid-neighbor')]);
    if (opened.mcpServerCatalog?.status !== 'ready') throw new Error('Fixture is not ready');
    await expect(resolve({ snapshot: { ...opened, mcpServerCatalog: { ...opened.mcpServerCatalog, status: 'partial',
      diagnostics: [{ path: 'servers[1]', reason: 'invalid-stored-content' }] } } })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable' });
  });

  it.each([true, false])('publishes optional catalog unavailability without borrowing ambient servers (built-in bridge: %s)', async includeHappierMcpServer => {
    setActiveAccountSettingsSnapshot(snapshot([server('ambient-server')]));
    const captured = { ...snapshot(), settings: accountSettingsParse({ mcpServersStrictMode: false }),
      rawSettings: { mcpServersSettingsV1: { v: 1, servers: [server('retained-server')], bindings: [] } },
      mcpServerCatalog: { status: 'unavailable' as const, reason: 'unreachable' as const } };
    const events: unknown[] = [];
    const result = await resolveRunnerMcpServers({ session: { ...session(), enqueueSessionEventCommitted: async event => {
      events.push(event); return { persisted: true, delivered: true };
    } }, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/tmp/repo', includeHappierMcpServer, env: {},
    });
    try {
      expect(Object.keys(result.mcpServers)).toEqual(includeHappierMcpServer ? ['happier'] : []);
      expect(events).toHaveLength(1);
      expect(readSessionCapabilityNoticeV1(events[0])).toEqual({ v: 1, items: [{
        kind: 'mcp_server', name: 'MCP servers', code: 'mcp_catalog_unavailable', detail: 'unreachable',
      }] });
    } finally { result.happierMcpServer.stop(); }
  });

  it('keeps built-in tools callable with an unobserved optional catalog and no Account preferences', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const events: unknown[] = [];
    const result = await resolveRunnerMcpServers({ session: { ...session(), getWorkDepth: () => 0,
      getActiveTurnPermissionWitness: () => ({ turnId: 'optional-startup-turn', workDepth: 0,
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
      enqueueSessionEventCommitted: async event => {
      events.push(event); return { persisted: true, delivered: true };
    } }, credentials, accountSettings: null, accountSettingsSnapshot: null,
      machineId: 'machine-1', directory: '/tmp/repo', env: {},
    });
    const client = new Client({ name: 'optional-mcp-startup', version: '1' });
    try {
      expect(readSessionCapabilityNoticeV1(events[0])?.items[0]).toMatchObject({ code: 'mcp_catalog_unavailable', detail: 'catalog-unobserved' });
      await client.connect(new StreamableHTTPClientTransport(new URL(result.happierMcpServer.url)));
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['action_execute', 'action_spec_get']));
      const reply = await client.callTool({ name: 'action_spec_get', arguments: { id: 'session.title.set' } });
      expect(reply, JSON.stringify(reply)).toMatchObject({ isError: false });
    } finally { await client.close(); result.happierMcpServer.stop(); }
  });

  it.each(['scope-retired', 'account-mode-mismatch'] as const)('refuses optional MCP catalog authority failure %s', async reason => {
    await expect(resolve({ snapshot: { ...snapshot(), settings: accountSettingsParse({ mcpServersStrictMode: false }),
      mcpServerCatalog: { status: 'unavailable', reason } } })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason });
  });

  it('refuses optional MCP startup when its captured Account retires during notice publication', async () => {
    const serverHttpBaseUrl = session().getServerBinding().serverUrl;
    const captured = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => ({ ...snapshot(),
      settings: accountSettingsParse({ mcpServersStrictMode: false }),
      mcpServerCatalog: { status: 'unavailable' as const, reason: 'unreachable' as const },
    }));
    let current = true;
    const operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials, snapshot: captured, serverHttpBaseUrl, isCurrent: async () => current,
    }));
    await expect(resolveRunnerMcpServers({ session: { ...session(), enqueueSessionEventCommitted: async () => {
      current = false; return { persisted: true, delivered: true };
    } }, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured, operationContext,
      machineId: 'machine-1', directory: '/tmp/repo', includeHappierMcpServer: false,
    })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'scope-retired' });
  });

  it.each([true, false])('keeps restricted Session authority independent from Account catalog availability (built-in bridge: %s)', async includeHappierMcpServer => {
    const result = await resolve({ snapshot: { ...snapshot(), mcpServerCatalog: { status: 'unavailable', reason: 'forbidden' } }, accountCredentials: null, includeHappierMcpServer });
    try { expect(Object.keys(result.mcpServers)).toEqual(includeHappierMcpServer ? ['happier'] : []); }
    finally { result.happierMcpServer.stop(); }
  });

  it('does not let retained root contents override a row-owned server set', async () => {
    const result = await resolve({ snapshot: { ...snapshot([server('row-server')]),
      rawSettings: { mcpServersSettingsV1: { v: 1, strictMode: false, servers: [server('retained-server')], bindings: [] } } } });
    try { expect(Object.keys(result.mcpServers).sort()).toEqual(['happier', 'row-server']); }
    finally { result.happierMcpServer.stop(); }
  });

  it('admits selected SavedSecret references only through the captured foreign Home invocation', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const serverHttpBaseUrl = 'https://private-runner-home.test';
    const resourceId = 'private-runner-resource';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const resource = { resourceId, ownerAccountId: 'private-owner', displayName: 'Private key', kind: 'apiKey' as const,
      encryptionMode: 'plain' as const, revision: 3, materialStatus: 'ready' as const,
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content: {
        v: 1, name: 'Private key', kind: 'apiKey', value: 'stale-private-value',
      } }),
    };
    const captured = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => snapshot([
      { ...server('private-server'), env: { API_KEY: { t: 'savedSecret', secretId: ref } } },
    ]));
    const operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials, serverHttpBaseUrl, snapshot: { ...captured, savedSecretCatalogState: 'ready', savedSecretResources: [resource] },
      isCurrent: async () => true,
    }));
    setActiveAccountSettingsSnapshot({ ...snapshot([server('unrelated-ambient-server')]),
      scopeKey: resolveAccountSettingsScopeKeyForToken('unrelated-ambient-account') });
    const ambient = getActiveAccountSettingsSnapshot();
    const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200 })));
    const fresh = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{ resourceId, encryptionMode: 'plain',
      entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Private key', kind: 'apiKey', ownerAccountId: 'private-owner',
        revision: 4, materialStatus: 'ready', capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content: {
        v: 1, name: 'Private key', kind: 'apiKey', value: 'fresh-private-value',
      } }), recipientEnvelope: null,
    }] });
    let revoked = false;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      if (String(input) !== `${serverHttpBaseUrl}/v1/account/saved-secrets/resources/materials`) throw new Error('Wrong Home material request');
      return { status: 200, data: revoked ? { resources: [] } : fresh };
    });
    const privateSession = { ...session(), getServerBinding: () => ({ serverId: 'private-home', serverUrl: serverHttpBaseUrl }) };
    const input = { session: privateSession, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      savedSecretResources: [resource], operationContext, machineId: 'machine-1', directory: '/tmp/repo', env: {}, tmpDir: null };
    const result = await resolveRunnerMcpServers(input);
    try {
      const launch = result.mcpServers['private-server'];
      expect(JSON.stringify(launch)).not.toContain('fresh-private-value');
      const configPath = launch?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
      expect(configPath).toBeDefined();
      expect(JSON.parse(await readFile(configPath!, 'utf8')).env.API_KEY).toBe('fresh-private-value');
      expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
    } finally { result.happierMcpServer.stop(); }
    revoked = true;
    await expect(resolveRunnerMcpServers(input)).rejects.toMatchObject({ code: 'saved_secret_resolution_failed', status: 'forbidden', reference: ref });
    expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
  });
});
