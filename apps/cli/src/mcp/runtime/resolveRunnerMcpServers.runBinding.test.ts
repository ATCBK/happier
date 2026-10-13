import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  accountSettingsParse,
  FeaturesResponseSchema,
  formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createExecutionRunOccurrenceWitnessRegistry } from '@/agent/runtime/bridges/executionRun/runOccurrenceWitness';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { SessionActionConfirmationRuntimeBinding } from '@/session/actions/approvals/sessionActionConfirmation';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDeferred } from '@/testkit/async/deferred';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';

const persistenceMocks = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));
const daemonCatalogBoundary = vi.hoisted(() => ({
  read: vi.fn(async (_input?: Readonly<{ signal?: AbortSignal }>) => ({ kind: 'available' as const, plugins: [] as [], tools: [] as [] })),
}));

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: persistenceMocks.readStoredCredentials,
}));

// The daemon catalog is a transport boundary; the MCP server and Action execution stay real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: daemonCatalogBoundary.read,
  // With no contributed metadata Action, the actual daemon reports unmatched
  // and the Session's built-in catalog owner handles this read.
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetActiveAccountSettingsSnapshotForTests();
  daemonCatalogBoundary.read.mockReset().mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
});

describe('Session-owned Run MCP binding', () => {
  it.each([false, true])('keeps Run MCP catalog admission independent of parent Stop and settles its own Run cancellation (optional Account MCP: %s)', async optionalAccountMcp => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const parentTurn = new AbortController();
    const lifetime = new AbortController();
    const witness: AgentInvocationTurnAdmissionWitness = {
      inputId: 'run-catalog-input', turnId: 'run-catalog-turn', userMessageSeq: 1, userMessageSeqs: [1],
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    };
    // Native controller identity is the provider boundary; occurrence ownership
    // and currentness are derived by the real registry, as in the adjacent test.
    const controller = { kind: 'backend', controllerOccurrenceId: 'run-catalog-occurrence' } as Extract<ExecutionRunController, { kind: 'backend' }>;
    const registry = createExecutionRunOccurrenceWitnessRegistry(new Map([['run-catalog', controller]]));
    const occurrence = registry.register({ runId: 'run-catalog', sidechainId: 'run-catalog-sidechain',
      controller, runtimeLifetimeSignal: lifetime.signal, readActiveTurnAdmissionWitness: () => witness });
    const notices: unknown[] = [];
    const parent = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'run-catalog-session', overrides: {
      enqueueSessionEventCommitted: async event => { notices.push(event); return { persisted: true, delivered: true }; },
    } }), {
      getHostTurnAbortSignal: () => parentTurn.signal,
    });
    const credentials = { token: 'run-catalog-fixture', encryption: null };
    const settings = accountSettingsParse({ mcpServersStrictMode: false });
    const binding = await resolveRunnerMcpServers({
      session: parent, credentials, accountCredentials: optionalAccountMcp ? credentials : null,
      accountSettings: settings,
      ...(optionalAccountMcp ? { accountSettingsSnapshot: {
        source: 'network' as const, settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
        mcpServerCatalog: { status: 'unavailable' as const, reason: 'unreachable' as const },
      } } : {}),
      machineId: 'run-machine', directory: '/run/catalog', env: {},
      executionRun: { runId: 'run-catalog', workDepth: 1, cwd: '/run/catalog', signal: lifetime.signal,
        isCurrent: () => !lifetime.signal.aborted, getPermissionMode: () => 'default',
        readActiveTurnAdmissionWitness: () => witness,
        readCurrentRunOccurrence: registry.reader.readCurrentRunOccurrence },
    });
    if (optionalAccountMcp) expect(readSessionCapabilityNoticeV1(notices[0])?.items[0])
      .toMatchObject({ code: 'mcp_catalog_unavailable', detail: 'unreachable' });
    const client = new Client({ name: 'run-catalog-cancellation', version: '1' });
    let entered = createDeferred<AbortSignal | undefined>();
    let release = createDeferred<void>();
    const holdCatalog = () => daemonCatalogBoundary.read.mockImplementation(async input => {
      entered.resolve(input?.signal);
      await new Promise<void>((resolve, reject) => {
        void release.promise.then(resolve);
        input?.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
      });
      return { kind: 'available', plugins: [], tools: [] };
    });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(binding.happierMcpServer.url)));
      holdCatalog();
      const surviving = client.callTool({ name: 'action_spec_get', arguments: { id: 'browser.view.open' } });
      try {
        const sourceSignal = await entered.promise;
        expect(sourceSignal).toBeDefined();
        parentTurn.abort();
        expect(lifetime.signal.aborted).toBe(false);
        expect(sourceSignal?.aborted).toBe(false);
        release.resolve();
        expect(await surviving).toMatchObject({ isError: false });
      } finally { release.resolve(); await Promise.allSettled([surviving]); }
      entered = createDeferred<AbortSignal | undefined>();
      release = createDeferred<void>();
      holdCatalog();
      const cancelled = fetch(binding.happierMcpServer.url, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'run-stop', method: 'tools/call',
          params: { name: 'action_spec_get', arguments: { id: 'browser.view.open' } } }),
      });
      try {
        const sourceSignal = await entered.promise;
        lifetime.abort();
        expect(sourceSignal?.aborted).toBe(true);
        const response = await cancelled;
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ ok: false, errorCode: 'cancelled' });
      } finally { release.resolve(); await cancelled; }
    } finally { release.resolve(); await client.close(); binding.happierMcpServer.stop(); occurrence.dispose(); }
  });

  it('refreshes selected shared Saved Secrets before composing an Execution Run MCP profile', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({
      features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {},
    }))));
    const token = 'runtime-test-token';
    const resourceId = 'revoked-run-mcp-resource';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const accountSettings = accountSettingsParse({ mcpServersStrictMode: true });
    const catalog = McpServerCatalogV1Schema.parse({
        v: 1,
        servers: [{
          id: 'shared-run-server',
          name: 'shared-run-server',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: { API_KEY: { t: 'savedSecret', secretId: ref } },
          createdAt: 1,
          updatedAt: 1,
        }],
        bindings: [{
          id: 'shared-run-binding',
          serverId: 'shared-run-server',
          enabled: true,
          target: { t: 'allMachines' },
          createdAt: 1,
          updatedAt: 1,
        }],
    });
    const staleResource = {
      resourceId,
      ownerAccountId: 'owner-account',
      displayName: 'Revoked run key',
      kind: 'apiKey' as const,
      encryptionMode: 'plain' as const,
      revision: 4,
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId,
        mode: 'plain',
        content: { v: 1, name: 'Revoked run key', kind: 'apiKey', value: 'stale-value' },
      }),
      materialStatus: 'ready' as const,
    };
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettings,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      savedSecretCatalogState: 'ready',
      savedSecretResources: [staleResource],
      mcpServerCatalog: { status: 'ready', authority: 'active', revision: 3, diagnostics: [], catalog },
    });
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });

    await expect(resolveRunnerMcpServers({
      session: {
        getServerBinding: () => ({ serverUrl: resolveServerHttpBaseUrl() }),
        enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
      } as Parameters<typeof resolveRunnerMcpServers>[0]['session'],
      credentials: { token, encryption: null },
      accountSettings,
      accountSettingsSnapshot: getActiveAccountSettingsSnapshot(),
      savedSecretResources: [staleResource],
      machineId: 'machine-a',
      directory: '/run/a',
      env: {},
      tmpDir: null,
      executionRun: {
        runId: 'run-a',
        workDepth: 0,
        cwd: '/run/a',
        signal: new AbortController().signal,
        isCurrent: () => true,
        readActiveTurnAdmissionWitness: () => null,
        readCurrentRunOccurrence: () => null,
      },
    })).rejects.toMatchObject({
      code: 'saved_secret_resolution_failed',
      status: 'forbidden',
      reference: ref,
    });
  });

  it('keeps the parent profile but binds confirmation to this Run occurrence and admitted turn', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const lifetime = new AbortController();
    const parentLifetime = new AbortController();
    const witness: AgentInvocationTurnAdmissionWitness = {
      inputId: 'input-run-a', turnId: 'turn-run-a', userMessageSeq: 3, userMessageSeqs: [3],
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    };
    const controller = {
      kind: 'backend',
      controllerOccurrenceId: 'run-a-occurrence-1',
    } as ExecutionRunController;
    const registry = createExecutionRunOccurrenceWitnessRegistry(new Map([['run-a', controller]]));
    const occurrence = registry.register({
      runId: 'run-a', sidechainId: 'sidechain-a', runtimeLifetimeSignal: lifetime.signal,
      controller: controller as Extract<ExecutionRunController, { kind: 'backend' }>,
      readActiveTurnAdmissionWitness: () => witness,
    });
    // A holder, not a `let`: narrowing across the MCP request boundary would
    // otherwise collapse the captured binding to `null` for the assertions below.
    const captured: { binding: SessionActionConfirmationRuntimeBinding | null } = { binding: null };
    const parent: Parameters<typeof resolveRunnerMcpServers>[0]['session'] = {
      sessionId: 'session-a',
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
      getServerBinding: () => ({
        serverId: 'test-home',
        serverUrl: 'https://test-home.example.test',
      }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'session-a', encryptionMode: 'plain' }),
      updateMetadata: () => undefined,
      getPermissionMode: () => 'yolo',
      getRuntimeLifetimeSignal: () => parentLifetime.signal,
      getServerFeaturesSnapshot: () => ({
        status: 'ready',
        provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({
          features: {
            sharing: {
              enabled: true,
              session: { enabled: true },
            },
            sessions: {
              enabled: true,
              conversations: { enabled: true },
            },
          },
          capabilities: {},
        }),
      }),
      getActiveTurnPermissionWitness: () => ({
        turnId: 'turn-parent',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
      }),
      confirmSessionAction: async (_request, binding) => {
        captured.binding = binding;
        return { decision: 'reject', isCurrent: () => true };
      },
    };
    const binding = await resolveRunnerMcpServers({
      session: parent,
      credentials: { token: 'runtime-test-token', encryption: null },
      accountSettings: accountSettingsParse({ actionsSettingsV1: {
        v: 1, actions: { 'session.activity.get': { approvalRequiredSurfaces: ['agent'] } },
      } }),
      accountSettingsSnapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('runtime-test-token'),
        mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [],
          catalog: { v: 1, servers: [], bindings: [] } } },
      machineId: 'machine-a', directory: '/run/a',
      resolvedMcpServers: { extra: { command: 'authorized-tool', env: { SECRET: 'already-resolved' } } },
      executionRun: {
        runId: 'run-a', workDepth: 4, cwd: '/run/a', signal: lifetime.signal,
        isCurrent: () => !lifetime.signal.aborted,
        getPermissionMode: () => 'default',
        readActiveTurnAdmissionWitness: () => witness,
        readCurrentRunOccurrence: registry.reader.readCurrentRunOccurrence,
      },
    });
    const client = new Client({ name: 'run-binding-test', version: '1' }, { capabilities: {} });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(binding.happierMcpServer.url)));
      const result = await client.callTool({ name: 'action_execute', arguments: { actionId: 'session.activity.get', input: { sessionId: 'session-a' } } });
      expect(captured.binding, JSON.stringify(result)).toMatchObject({
        turnId: 'turn-run-a',
        run: { runId: 'run-a', sidechainId: 'sidechain-a', occurrenceId: occurrence.occurrence.occurrenceId },
      });
      expect(binding.mcpServers.extra).toEqual({ command: 'authorized-tool', env: { SECRET: 'already-resolved' } });
      expect(binding.happierMcpServer.supportedSessionReadActions).toEqual([
        'session.transcript.get',
        'session.discussion.list',
        'session.discussion.get',
        'session.discussion.read',
      ]);
      expect(binding.happierMcpServer.supportedSessionReadActions).not.toContain('session.discussion.post');
      expect(parent.getActiveTurnPermissionWitness?.()?.turnId).toBe('turn-parent');
      expect(captured.binding?.isCurrent()).toBe(true);
      occurrence.dispose();
      expect(captured.binding?.isCurrent()).toBe(false);
    } finally {
      await client.close();
      binding.happierMcpServer.stop();
    }
  });
});
