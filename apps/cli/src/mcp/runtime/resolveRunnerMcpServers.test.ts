import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountSettingsParse, FeaturesResponseSchema, formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1, type McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import * as persistence from '@/persistence';
import type { HappyMcpSessionClient } from '../startHappyServer';
import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';

// The daemon catalog is an IPC boundary. Runtime, bridge, selectors and
// materialization remain real, including the local HTTP listener lifecycle.
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }),
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
function resolve(input: Readonly<{ snapshot: ActiveAccountSettingsSnapshot | null; accountCredentials?: null; includeHappierMcpServer?: boolean }>) {
  vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
  return resolveRunnerMcpServers({ session: session(), credentials,
    ...(input.accountCredentials === null ? { accountCredentials: null } : {}),
    accountSettings: input.snapshot?.settings ?? accountSettingsParse({}), accountSettingsSnapshot: input.snapshot,
    machineId: 'machine-1', directory: '/tmp/repo', env: {}, tmpDir: null,
    includeHappierMcpServer: input.includeHappierMcpServer });
}

describe('resolveRunnerMcpServers catalog admission', () => {
  it('resolves Project rules once before materializing and refuses an unreadable association', async () => {
    const captured = snapshot([server('tools')]);
    captured.mcpServerCatalog!.catalog!.bindings[0]!.target = { t: 'project', projectKey: 'project' };
    const serverId = session().getServerBinding().serverId;
    const key = { kind: 'workspace-ref', serverId, id: 'checkout' };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
    const request = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
      { key, revision: 1, content: { t: 'plain', v: { key, value: { id: 'checkout', serverId, machineId: 'machine-1',
        rootPath: '/repo', projectKey: 'project', createdAtMs: 1 } } } },
    ] } });
    const input = { session: session(), credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/repo', agentId: 'codex', agentAcceptsUserMcp: true,
      sessionMetadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' }, includeHappierMcpServer: false as const };
    const result = await resolveRunnerMcpServers(input);
    try { expect(Object.keys(result.mcpServers)).toEqual(['tools']); } finally { result.happierMcpServer.stop(); }
    expect(request.mock.calls.filter(call => call[0].endsWith('/projects/account-rows/list'))).toHaveLength(1);
    request.mockRejectedValue(new Error('network_unavailable'));
    await expect(resolveRunnerMcpServers(input)).rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_association_unavailable' });
    request.mockClear();
    const unsupported = await resolveRunnerMcpServers({ ...input, agentAcceptsUserMcp: false });
    try { expect(Object.keys(unsupported.mcpServers)).toEqual([]); } finally { unsupported.happierMcpServer.stop(); }
    expect(request).not.toHaveBeenCalled();
  });
  it('keeps other servers available when non-strict OAuth capability admission fails', async () => {
    const captured = snapshot([server('static'), { id: 'oauth', name: 'oauth', transport: 'http', remote: { url: 'https://mcp.example.test/path', headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const nonStrict = { ...captured, settings: accountSettingsParse({ mcpServersStrictMode: false }) };
    const result = await resolveRunnerMcpServers({ session: { ...session(), getMcpRequestAuthPort: () => ({
      open: async () => { throw new Error('daemon_unavailable'); }, close: async () => undefined,
    }) }, credentials, accountSettings: nonStrict.settings, accountSettingsSnapshot: nonStrict,
    machineId: 'machine-1', directory: '/repo', tmpDir: null, includeHappierMcpServer: false });
    try { expect(Object.keys(result.mcpServers)).toEqual(['static']); } finally { result.happierMcpServer.stop(); }
  });
  it('opens a per-server OAuth capability through the admitted Session port and closes it with the MCP profile', async () => {
    const resource = 'https://mcp.example.test/path';
    const captured = snapshot([{ id: 'oauth', name: 'oauth', transport: 'http', remote: { url: resource, headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }]);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-runner-auth-'));
    const opened: Array<Parameters<import('./mcpRequestAuth').McpRequestAuthPort['open']>[0]> = [];
    const closed: string[] = [];
    // The authenticated daemon channel is the system boundary; runner selection and materialization stay real.
    const port: import('./mcpRequestAuth').McpRequestAuthPort = {
      async open(input) { opened.push(input); return { capabilityFile: join(root, 'capability.json'), resource }; },
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
      expect(opened[0]).toMatchObject({ serverId: 'oauth', resource });
      const config = JSON.parse(await readFile(resolved.mcpServers.oauth!.env!.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE!, 'utf8'));
      expect(config.auth).toEqual({ capabilityFile: join(root, 'capability.json'), resource });
      resolved.happierMcpServer.stop();
      expect(closed).toEqual([opened[0]!.materializationId]);
    } finally { resolved?.happierMcpServer.stop(); await rm(root, { recursive: true, force: true }); }
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
      expect(resolved.mcpServers.selected?.env?.USER_VALUE).toBe('materialized-value');
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
    const enqueueSessionEventCommitted = vi.fn(async () => ({ persisted: true, delivered: true }));
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const resolved = await resolveRunnerMcpServers({
      session: { ...session(), enqueueSessionEventCommitted }, credentials,
      accountSettings: captured.settings, accountSettingsSnapshot: captured,
      machineId: 'machine-1', directory: '/tmp/repo', env: {},
      includeHappierMcpServer,
    });
    try {
      expect(resolved.mcpServers.linear).toBeUndefined();
      expect(resolved.mcpServers.docs).toBeDefined();
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
      session: { ...session(), getMetadataSnapshot: () => ({ attestedContext: {
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
      expect(resolved.mcpBindingIdentities).toEqual({ docs: {
        serverId: 'docs', bindingId: 'binding-docs', serverRevision: 10, bindingRevision: 20, catalogRevision: 2,
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

  it('refuses unobserved and partial catalogs rather than silently dropping custom servers', async () => {
    setActiveAccountSettingsSnapshot(snapshot([server('ambient-server')]));
    await expect(resolve({ snapshot: null })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'catalog-unobserved' });
    const withoutPreferences = resolveRunnerMcpServers({ session: session(), credentials, accountSettings: null,
      machineId: 'machine-1', directory: '/tmp/repo' }).then(result => { result.happierMcpServer.stop(); return result; });
    await expect(withoutPreferences).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'catalog-unobserved' });
    const opened = snapshot([server('valid-neighbor')]);
    if (opened.mcpServerCatalog?.status !== 'ready') throw new Error('Fixture is not ready');
    await expect(resolve({ snapshot: { ...opened, mcpServerCatalog: { ...opened.mcpServerCatalog, status: 'partial',
      diagnostics: [{ path: 'servers[1]', reason: 'invalid-stored-content' }] } } })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable' });
  });

  it('does not admit an unavailable row even when non-strict policy is selected', async () => {
    await expect(resolve({ snapshot: { ...snapshot(), settings: accountSettingsParse({ mcpServersStrictMode: false }),
      mcpServerCatalog: { status: 'unavailable', reason: 'unreachable' } } })).rejects.toMatchObject({ code: 'mcp_catalog_unavailable' });
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
    const privateSession: HappyMcpSessionClient = { ...session(), getServerBinding: () => ({ serverId: 'private-home', serverUrl: serverHttpBaseUrl }) };
    const input = { session: privateSession, credentials, accountSettings: captured.settings, accountSettingsSnapshot: captured,
      savedSecretResources: [resource], operationContext, machineId: 'machine-1', directory: '/tmp/repo', env: {}, tmpDir: null };
    const result = await resolveRunnerMcpServers(input);
    try {
      expect(result.mcpServers['private-server']?.env?.API_KEY).toBe('fresh-private-value');
      expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
    } finally { result.happierMcpServer.stop(); }
    revoked = true;
    await expect(resolveRunnerMcpServers(input)).rejects.toMatchObject({ code: 'saved_secret_resolution_failed', status: 'forbidden', reference: ref });
    expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
  });
});
