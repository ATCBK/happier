import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { AgentSessionRuntime, AgentSessionOpenRequest, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { accountSettingsParse } from '@happier-dev/protocol';
import { listVoiceActionBlockSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { isActionDirectToolExposedOn } from '@happier-dev/protocol/actions/actionToolExposure';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';
import { SessionExecutionRunBrokerAuthorityRequestV1Schema, SessionExecutionRunBrokerAuthorityResponseV1Schema } from '@happier-dev/protocol/daemon/executionRuns';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { McpRequestAuthPort } from '@/mcp/runtime/mcpRequestAuth';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { toAgentSessionMcpLaunchConfigs } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createDeferred } from '@/testkit/async/deferred';
import { reloadConfiguration } from '@/configuration';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import '@/agent/runtime/registry/engineRegistry/runtimeCore';

// Credential persistence and Home HTTP are external boundaries. Never read a
// developer's credentials or contact a real Account from the authored Agent.
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ token: 'voice-mcp-fixture', encryption: null }),
}));
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration(); resetActiveAccountSettingsSnapshotForTests(); });

describe('Voice Run MCP provisioning occurrence', () => {
  it('keeps Global fixed-Agent Voice start/resume tools and prompt aligned with Agent policy', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-voice-mcp-occurrence-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    reloadConfiguration();
    const actualFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).hostname === '127.0.0.1') return actualFetch(input, init);
      throw new Error('Unexpected fixture Home request');
    }));
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected fixture Home request'));
    vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected fixture Home request'));
    const resource = 'https://mcp.example.test/voice';
    const settings = accountSettingsParse({ mcpServersStrictMode: true });
    const snapshot = { source: 'network' as const, settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('voice-mcp-fixture'),
      mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const, revision: 1, diagnostics: [], catalog: { v: 1 as const,
        servers: [{ id: 'voice-oauth', name: 'voice-oauth', transport: 'http' as const,
          remote: { url: resource, headers: {}, auth: { kind: 'oauth' as const } }, env: {}, createdAt: 1, updatedAt: 1 }],
        bindings: [{ id: 'voice-rule', serverId: 'voice-oauth', enabled: true, target: { t: 'allMachines' as const }, createdAt: 1, updatedAt: 1 }],
      } } };
    let bridge: ExecutionRunHostBridge | undefined;
    const proofs: Array<{ runId: string; occurrenceId: string }> = [];
    const opened: AgentSessionOpenRequest[] = [];
    const prompts: string[] = [];
    const directTools = listVoiceActionBlockSpecs().filter(spec => isActionDirectToolExposedOn(spec, 'agent'))
      .map(spec => spec.bindings!.voiceClientToolName!);
    const closed: string[] = [];
    let holdProvider = false;
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const port: McpRequestAuthPort = {
      async open(input) {
        if (!bridge || !input.executionRun) throw new Error('Missing exact Run proof');
        // The authenticated daemon RPC is the boundary. Feed the real host
        // producer through its strict consumer; no synthetic current reply.
        const proof = SessionExecutionRunBrokerAuthorityRequestV1Schema.parse({ v: 1,
          executionRunId: input.executionRun.runId, expectedOccurrenceId: input.executionRun.occurrenceId });
        const current = SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(bridge.resolveLiveBrokerAuthority(proof));
        if (current.status !== 'current' || current.executionRunId !== input.executionRun.runId
          || current.occurrenceId !== input.executionRun.occurrenceId || current.parentSessionId !== 'voice-parent') {
          throw new Error('mcp_request_auth_not_active');
        }
        expect(current).toMatchObject({ intent: 'voice_agent', runtimeState: 'idle', activeTurnId: null });
        proofs.push(input.executionRun);
        return { capabilityFile: join(home, `capability-${input.materializationId}.json`), resource };
      },
      async close(input) { closed.push(input.materializationId); },
    };
    const openSession = async (request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> => {
      opened.push(request);
      const happier = request.mcpServers?.happier;
      const urlIndex = happier?.args?.indexOf('--url') ?? -1;
      const url = happier?.args?.[urlIndex + 1];
      if (urlIndex < 0 || !url) throw new Error('Missing real Happier MCP bridge');
      const client = new Client({ name: 'voice-settings-exposure', version: '1' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));
        const catalog = await client.listTools();
        expect(catalog.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
          'settings_list', 'settings_get', 'settings_set', 'settings_reset',
        ]));
      } finally { await client.close(); }
      const selected = request.mcpServers?.['voice-oauth'];
      expect(selected).toBeDefined();
      if (!selected) throw new Error('Expected request-auth bridge');
      const configPath = selected.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE;
      if (!configPath) throw new Error('Missing materialized OAuth configuration');
      expect(JSON.parse(await readFile(configPath, 'utf8')).auth).toMatchObject({ resource });
      if (holdProvider) { entered.resolve(); await release.promise; }
      let sequence = 0;
      const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
      return { watch(listener) {
        listeners.add(listener);
        listener({ kind: 'provider-session-id', sessionId: request.sessionId, providerSessionId: 'voice-native-thread', sequence: ++sequence, emittedAtMs: sequence });
        return { dispose() { listeners.delete(listener); } };
      }, async send(input) {
        prompts.push(input.input.text);
        for (const event of [
          { kind: 'input-accepted' as const, inputIds: input.inputIds, delivery: input.delivery },
          { kind: 'turn-start' as const, turnId: input.delivery.turnId, startedBy: 'host' as const },
          { kind: 'message-delta' as const, turnId: input.delivery.turnId, channel: 'assistant' as const, text: 'READY' },
          { kind: 'turn-complete' as const, turnId: input.delivery.turnId },
        ]) for (const listener of listeners) listener({ ...event, sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
        return { status: 'admitted' };
      }, async dispose() { listeners.clear(); } };
    };
    const plugin = definePlugin({ id: 'test.voice-mcp-occurrence', version: '0.0.0', displayName: 'Voice MCP fixture',
      hostAccess: { required: [{ id: 'session-runtime', capability: 'sessions', reason: 'Use the current Session.',
        scope: { access: ['read', 'write', 'control'] } }], optional: [] },
      entrypoints: { daemon: './daemon.mjs' }, agents: { agent: {
        declaration: { title: 'Voice MCP Agent', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { tools: { delivery: 'native_mcp' }, sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false } } },
        factory: () => ({ sessions: { open: openSession } }),
        sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      } } });
    let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    try {
      fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, happyHomeDir: home,
        plugins: [{ manifest: plugin.manifest, files: {
          'agent-runtime.mjs': 'let open; export function configure(callback) { open = callback; } export function createRuntime() { return { sessions: { open: request => open(request) } }; }',
          'daemon.mjs': "import * as leaf from './agent-runtime.mjs'; export function activate(api) { api.agents.register('agent', leaf.createRuntime, { sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 } }); } export function configureUnitLeaf(open) { leaf.configure(open); return { activate }; }",
        }, instantiateCommittedModule(module) {
          const configure = module.configureUnitLeaf;
          if (typeof configure !== 'function') throw new Error('Missing provider fixture');
          return configure(openSession) as PluginDaemonModuleNamespace;
        } }] });
      const agent = { pluginId: plugin.manifest.id, localId: 'agent' };
      const agentId = `${agent.pluginId}/${agent.localId}`;
      const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
      const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({ resolveAgentIdentity: () => agent });
      const parent = createMutableApiSessionClientFixture({ sessionId: 'voice-parent', metadata: createTestMetadata({ path: home,
        systemSessionV1: { v: 1, key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true },
        voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
        voiceConversationBindingV1: { v: 1, adapterId: 'local_conversation', controlSessionId: '__voice_agent__',
          transcriptMode: 'native_session', targetSessionId: null, updatedAt: 1 },
      }),
        overrides: { getMcpRequestAuthPort: () => port } });
      bridge = new ExecutionRunHostBridge({ parentProvider: 'claude', cwd: home, happyHomeDir: home, sendAcp: async () => {},
        resolveRunReportPolicy: async () => ({ preset: 'important' }),
        getNowMs: () => 1_700_000_000_000, resolveAccountSettingsSnapshot: async () => snapshot,
        sessionInteractionHost: { session: parent, machineId: 'voice-machine', permissionHandler: new ProviderEnforcedPermissionHandler(parent, { logPrefix: '[Voice MCP]' }),
          // Compose the native host's tool-binding port with its real MCP owner,
          // as registerSessionClientRuntimeHandlers does. No internal stand-in.
          composeRunToolBinding: async request => {
            const resolved = await resolveRunnerMcpServers({ session: parent, credentials: { token: 'voice-mcp-fixture', encryption: null },
              accountSettings: settings, accountSettingsSnapshot: snapshot, machineId: 'voice-machine', directory: home,
              agentId: request.agentId, agentAcceptsUserMcp: true, executionRun: { ...request, getPermissionMode: () => 'read-only' },
            });
            return { mcpServers: toAgentSessionMcpLaunchConfigs(resolved.mcpServers), supportedSessionReadActions: [],
              dispose: () => resolved.happierMcpServer.stop() };
          },
        },
        resolveVoicePromptPreparation: async args => await resolveCliVoicePromptPreparation({ ...args,
          sessionMetadata: parent.getMetadataSnapshot(), accountEntries: [], profileEntries: [], directory: home }),
        resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry }) });
      const started = await bridge.start({ sessionId: parent.sessionId, intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
        chatModelId: 'voice-model', commitModelId: 'default', bootstrapMode: 'ready_handshake', initialContextMode: 'first_turn', connectedServices: null });
      expect(proofs).toHaveLength(1);
      expect(opened).toHaveLength(1);
      // Local Voice's action-block instructions must not hide the Agent-direct
      // catalog the same native provider has just received over real MCP.
      expect(prompts).toHaveLength(1);
      expect([...prompts[0]!.matchAll(/^- ([A-Za-z0-9_]+):/gm)].map(match => match[1]))
        .toEqual(expect.arrayContaining(directTools));
      const first = proofs[0]!;
      expect(bridge.readExecutionRunOccurrenceWitnessReader().readCurrentRunOccurrence(started.runId)?.occurrenceId).toBe(first.occurrenceId);
      expect(bridge.resolveLiveBrokerAuthority({ v: 1, executionRunId: started.runId, expectedOccurrenceId: randomUUID() }))
        .toEqual({ status: 'not_current', reason: 'occurrence_mismatch' });
      await bridge.stop(started.runId);
      await bridge.waitForTerminal(started.runId);
      expect(bridge.readExecutionRunOccurrenceWitnessReader().readCurrentRunOccurrence(started.runId)).toBeNull();
      expect(closed).toHaveLength(1);
      holdProvider = true;
      const resuming = bridge.ensure(started.runId, { resume: true });
      try {
        await Promise.race([entered.promise, resuming.then(result => { throw new Error(`Resume settled before provider open: ${JSON.stringify(result)}`); })]);
        expect(proofs).toHaveLength(2);
        expect(proofs[1]?.occurrenceId).not.toBe(first.occurrenceId);
        expect(bridge.resolveLiveBrokerAuthority({ v: 1, executionRunId: started.runId, expectedOccurrenceId: first.occurrenceId }))
          .toEqual({ status: 'not_current', reason: 'occurrence_mismatch' });
        const stopping = bridge.stop(started.runId);
        await vi.waitFor(() => expect(bridge!.get(started.runId)?.status).toBe('cancelled'));
        expect(bridge.readExecutionRunOccurrenceWitnessReader().readCurrentRunOccurrence(started.runId)).toBeNull();
        release.resolve();
        await stopping;
      } finally { release.resolve(); await resuming; }
    } finally {
      release.resolve();
      await bridge?.dispose();
      await fixture?.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});
