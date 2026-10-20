import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { configuration } from '@/configuration';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import * as processIdentity from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH, AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry/registry';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { probeMcpStdioServerTools } from '@/mcp/servers/probeMcpStdioServerTools';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { buildCodexAppServerConfigOverrides, assignInjectedServerKeys } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/config/overrides';
import { resolveClaudeLaunchSettingsOverlayArgs } from '../../../../../packages/plugins/claude/src/agent/runtime/launchSettings';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Only the private HTTP listener is substituted. Installation, source custody,
// runner admission, daemon dispatch, attachment and MCP discovery stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.control = null; });

it.each([false, true])('delivers an external plugin through the daemon runner bridge and retires reapply/Stop attachments (native collision: %s)', async (nativeCollision) => {
  const pluginId = 'acme.project-launch';
  const serverId = `plugin:${pluginId}/tools`;
  const wireName = nativeCollision ? 'tools_2' : 'tools';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, {
    manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
      agents: [{ id: 'agent', title: 'Fixture Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
      mcp: { servers: [{ id: 'tools', kind: 'dynamic', sessionScope: 'session', title: 'Fixture tools' }],
        discoverySources: nativeCollision ? [{ id: 'native-config', title: 'Native fixture', loadedInHappierSessions: true,
          metadata: { agentId: `${pluginId}/agent` } }] : [] },
    } }),
    files: {
      'agent.mjs': `export function factory() { return { sessions: { open() { throw new Error('Native launch is observed separately'); } } }; }`,
      'daemon.mjs': `import { factory } from './agent.mjs';
        export function activate(api) {
          api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } });
          ${nativeCollision ? `api.mcp.registerDiscoverySource('native-config', async () => ({ items: [],
            endpoints: [{ id: 'native-tools', name: 'tools', kind: 'http', url: 'https://native.example.test/mcp' }] }));` : ''}
          api.mcp.registerServer('tools', {
            async listTools() { return { items: [{ name: 'echo', inputSchema: { type: 'object' } }] }; },
            async callTool(input) { return { echoed: input }; },
            async listResources() { return { items: [] }; }, async listResourceTemplates() { return { items: [] }; },
            async readResource(request) { return { contents: [{ uri: request.uri, text: '' }] }; },
            async subscribeResource() { return { dispose() {} }; }, async listPrompts() { return { items: [] }; },
            async getPrompt() { return { messages: [] }; }, async dispose() {}
          });
        }`,
    },
  });
  const runnerCommand = `${process.execPath} ${join(h.f.directory, '.runner-snapshots', 'fixture-runner', 'index.mjs')}`;
  h.runner.snapshotIdentity = 'snapshot:fixture-runner';
  h.runner.processCommandHash = hashProcessCommand(runnerCommand);
  h.tracked.processCommandHash = h.runner.processCommandHash;
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid,
    processStartTimeMs: h.runner.processStartTimeMs, command: runnerCommand });
  const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing });
  await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing,
    path: authorityFilePath, sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
  const homeFetch = globalThis.fetch;
  const endpoints: string[] = [];
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(url)).pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return await homeFetch(url, init);
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    const delivery = new AbortController();
    const response = await boundary.control!.agentRuntimeDaemonServices!.dispatch(request, {
      sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, trackedSession: h.tracked,
      invocationContext: h.tracked.runnerAgentInvocationContext!, isCurrent: async () => true,
      signal: init?.signal ? AbortSignal.any([init.signal, delivery.signal]) : delivery.signal,
    });
    if (response.ok && response.result.kind === 'mcp.plugin.materialized') {
      for (const server of response.result.servers) {
        if (server.id === serverId && (server.transport.kind === 'http' || server.transport.kind === 'sse')) endpoints.push(server.transport.url);
      }
    }
    // A delivered response closes its HTTP request lifetime. Real discovery
    // below must still work against the Session-owned hosted endpoint.
    delivery.abort();
    return Response.json(response);
  });
  const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: h.sessionId });
  if (!source) throw new Error('Missing real runner admission');
  let runnerExited = false;
  onTestFinished(() => runnerExited ? undefined : source.retire?.());
  const engines = await resolveCliEngineRegistry({ happyHomeDir: h.f.directory, backendId: source.identity.backendId,
    requireRunnerAgentSessionRuntimeSource: true, runnerAgentSessionRuntimeSource: source });
  const resolution = await engines.resolveForBackendId(source.identity.backendId);
  if (!resolution) throw new Error('Missing runner engine');
  const plan = await resolution.engineAdapter.runtimeCore.createSessionRuntime({ credentials: h.f.bootstrap.credentials,
    directory: h.cwd, backendTarget: { kind: 'backend', backendId: source.identity.backendId } });
  const bridge = plan.deps?.sessionLoopLifecycleDeps?.daemonTurnContributionsBridge;
  const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] });
  const settings = accountSettingsParse({});
  const session = applyRunnerMcpSessionContext({ sessionId: h.sessionId,
    getServerBinding: () => ({ serverId: 'session-home', serverUrl: 'https://session-home.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: h.sessionId, encryptionMode: 'plain' }), updateMetadata() {},
    enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
  }, { getPluginMcpPort: () => bridge?.pluginMcp ?? null });
  const input = { session, credentials: h.f.bootstrap.credentials, accountSettings: settings,
    accountSettingsSnapshot: { source: 'network' as const, settings, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(h.f.bootstrap.credentials.token),
      mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const, catalog, revision: 1, diagnostics: [] } },
    machineId: 'machine', directory: h.cwd, agentId: source.identity.backendId, agentAcceptsUserMcp: true,
    mcpToolControl: { off: 'hidden' as const, approval: 'native' as const },
    includeHappierMcpServer: false as const, tmpDir: h.f.directory,
    sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [serverId], forceExcludeServerIds: [] } },
  };
  vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
  const first = await resolveRunnerMcpServers(input);
  onTestFinished(() => first.happierMcpServer.stop());
  expect(Object.keys(first.mcpServers)).toEqual([wireName]);
  expect(first.mcpServerIdentities?.[wireName]).toMatchObject({ serverId, plugin: { pluginId, localId: 'tools' } });
  expect(first.mcpToolPolicy?.[wireName]).toEqual({ unlisted: 'ask', tools: {} });
  const key = assignInjectedServerKeys([wireName]).get(wireName);
  expect(buildCodexAppServerConfigOverrides(first.mcpServers, { mcpToolPolicy: first.mcpToolPolicy }))
    .toContain(`mcp_servers.${key}.default_tools_approval_mode="prompt"`);
  const claudeArgs = resolveClaudeLaunchSettingsOverlayArgs({ args: [], interactionKind: 'noninteractive_sdk',
    permissionMode: 'default', launchSettings: {}, mcpToolPolicy: first.mcpToolPolicy });
  expect(claudeArgs.join(' ')).toContain(`mcp__${wireName}`);
  expect((await probeMcpStdioServerTools({ config: first.mcpServers[wireName]! })).tools.map(tool => tool.name)).toEqual(['echo']);

  // Reapply owns a new attachment. Retiring the previous applied profile must
  // close its endpoint without closing the successor.
  const second = await resolveRunnerMcpServers({ ...input, session: applyRunnerMcpSessionContext(session, { getPermissionMode: () => 'yolo' }) });
  onTestFinished(() => second.happierMcpServer.stop());
  expect(second.mcpToolPolicy?.[wireName]).toEqual({ unlisted: 'allow', tools: {} });
  expect(endpoints).toHaveLength(2);
  expect(endpoints[0]).not.toBe(endpoints[1]);
  first.happierMcpServer.stop();
  await vi.waitFor(async () => { await expect(homeFetch(endpoints[0]!)).rejects.toThrow(); });
  expect((await probeMcpStdioServerTools({ config: second.mcpServers[wireName]! })).tools.map(tool => tool.name)).toEqual(['echo']);
  h.tracked.stopRequestedAtMs = Date.now();
  await expect(bridge!.pluginMcp!.prepare({ catalog, directory: h.cwd })).rejects.toMatchObject({ code: 'plugin_mcp_preparation_unavailable' });
  await h.daemon.onChildExited(h.tracked.pid, { reason: 'explicit-stop', code: 0, signal: null });
  runnerExited = true;
  await expect(homeFetch(endpoints[1]!)).rejects.toThrow();
  await expect(probeMcpStdioServerTools({ config: second.mcpServers[wireName]! })).rejects.toThrow();
  // The daemon already retired these attachments. Repeated local retirement
  // must drain the stand-in's handles without restoring either endpoint.
  await source.retire?.();
}, 180_000);
