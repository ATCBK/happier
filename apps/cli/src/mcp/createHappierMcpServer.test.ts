import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import Ajv from 'ajv';
import { z } from 'zod/mini';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { accountSettingsParse, deriveSessionCreationTagV1, FeaturesResponseSchema, normalizeActionsSettingsV1, projectSessionAccessCapabilitiesV1, SessionCreationCorrespondenceV1Schema, SessionInputRequestSchema, V2SessionByIdResponseSchema, type AccountSettings } from '@happier-dev/protocol';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { encrypt, decrypt, encodeBase64 } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import * as daemonControlClient from '@/daemon/controlClient';
import { restartSessionRunnerOnCurrentRuntime } from '@/daemon/plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { requestPlannedRunnerRestart } from '@/daemon/plannedRunnerRestart/requestPlannedRunnerRestart';
import type { TrackedSession } from '@/daemon/types';
import { ActionDiscoveryDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import type { HappyMcpSessionClient } from './startHappyServer';
import { createSessionDaemonAuthorityFixture } from './runtime/sessionDaemonAuthority.testkit';
import { configuration } from '@/configuration';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, readCurrentRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const env = process.env;

const getTestServerBinding = () => ({
  serverId: 'test-home',
  serverUrl: 'https://test-home.example.test',
} as const);

async function installAccountCatalogDaemonTransport(params: Readonly<{
  sessionId: string;
  readMetadata: () => Readonly<Record<string, unknown>> | null;
  mode?: 'plain' | 'e2ee';
}>) {
  const mode = params.mode ?? 'plain';
  const secret = new Uint8Array(32).fill(17);
  const credentials = { token: 'catalog-test-token', encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
  const app = fastify();
  const restore = installAxiosFastifyAdapter({ app, origin: getTestServerBinding().serverUrl });
  let sessionReads = 0;
  app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode }));
  app.get('/v2/sessions/:sessionId', async (_request, reply) => {
    sessionReads += 1;
    const metadata = params.readMetadata();
    if (!metadata) return reply.code(404).send({ error: 'not_found' });
    return { session: createSessionRecordFixture({ id: params.sessionId, encryptionMode: mode,
      metadata: mode === 'plain' ? JSON.stringify(metadata) : encodeBase64(encrypt(secret, 'legacy', metadata)),
    }) };
  });
  const executor = createCliActionExecutorFromCredentials({
    credentials, serverId: getTestServerBinding().serverId, serverApiUrl: getTestServerBinding().serverUrl,
    pluginActionExecutionOwner: 'current_process',
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
    resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated',
      features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
  });
  // Only daemon IPC and Home HTTP are substituted. The credentialed daemon
  // catalog, current Session metadata opening and availability stay real.
  vi.spyOn(daemonControlClient, 'requestDaemonPluginActionExecution').mockImplementation(async (request) => {
    const result = await executor.execute(ActionIdSchema.parse(request.actionId), request.input, {
      surface: request.surface, authority: 'account_automation', actionCaller: { kind: 'host' },
      ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
    });
    return { matched: true, result: result.ok
      ? { ok: true, result: StrictJsonValueSchema.parse(result.result) }
      : { ok: false, errorCode: result.errorCode, error: result.error } };
  });
  return { executor, getSessionReads: () => sessionReads, close: async () => { restore(); await app.close(); } };
}

const catalogHostTurn = {
  getWorkDepth: () => 0,
  getHostTurnWorkDepth: (turnId: string) => turnId === 'catalog-turn' ? 0 : undefined,
  getActiveTurnPermissionWitness: () => ({ turnId: 'catalog-turn',
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } }),
};

function hostClient(sessionId: string, overrides: Partial<HappyMcpSessionClient> = {}): HappyMcpSessionClient {
  return {
    sessionId,
    getServerBinding: getTestServerBinding,
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {},
    getMetadataSnapshot: () => createTestMetadata(),
    ...catalogHostTurn,
    ...overrides,
  };
}

async function withMcpClient(runtime: ReturnType<typeof createHappierMcpServer>, run: (client: Client) => Promise<void>) {
  const client = new Client({ name: 'session-mcp-contract-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await runtime.mcp.close();
  }
}

async function withTitleHost(
  sessionId: string,
  getAccountSettings: () => AccountSettings,
  run: (fixture: Readonly<{
    runtime: ReturnType<typeof createHappierMcpServer>;
    readSharedMetadata: () => unknown;
    persistedWrites: () => number;
    localWrites: () => number;
  }>) => Promise<void>,
) {
  const credentials = { token: 'title-daemon-account', encryption: null };
  const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
    metadata: createTestMetadata(), agentState: null });
  let metadata = fields.sharedMetadata.ciphertext;
  let ownerMetadata = fields.ownerMetadata;
  let metadataVersion = 1;
  let agentStateVersion = 0;
  let writes = 0;
  let localWrites = 0;
  const app = fastify();
  const restore = installAxiosFastifyAdapter({ app, origin: getTestServerBinding().serverUrl });
  app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
  app.get('/v2/sessions/:sessionId', async () => V2SessionByIdResponseSchema.parse({ session: createSessionRecordFixture({ id: sessionId,
    encryptionMode: 'plain', metadataLayoutVersion: 1, metadata, ownerMetadata, metadataVersion, agentStateVersion, share: null,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
  }) }));
  app.patch('/v2/sessions/:sessionId', async request => {
    const patch = SessionMetadataTuplePatchV1Schema.parse(request.body);
    if (patch.mode !== 'owner') throw new Error('Expected an owner metadata tuple');
    expect(patch.sharedMetadata.expectedVersion).toBe(metadataVersion);
    expect(patch.expectedOwnerMetadata).toEqual(ownerMetadata);
    metadata = patch.sharedMetadata.ciphertext;
    ownerMetadata = patch.ownerMetadata;
    writes += 1;
    return SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: ++metadataVersion }, agentState: { version: ++agentStateVersion } });
  });
  // Home persistence and the daemon are external boundaries. The actual Action
  // policy, title mutation, envelope projection and HTTP CAS remain real.
  const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials, sessionId,
    mode: 'plain', ctx: null, serverId: getTestServerBinding().serverId, serverHttpBaseUrl: getTestServerBinding().serverUrl,
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(getAccountSettings().actionsSettingsV1) },
  });
  const daemon = await createSessionDaemonAuthorityFixture({ sessionId,
    execute: operation => executor.execute(ActionIdSchema.parse(operation.actionId), operation.input,
      { surface: operation.surface, authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: sessionId }),
  });
  const runtime = createHappierMcpServer(hostClient(sessionId, {
    updateMetadata: () => { localWrites += 1; },
    getActiveTurnAdmissionWitness: () => ({ turnId: 'title-turn', inputId: 'title-input', userMessageSeq: 1, userMessageSeqs: [1],
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
  }), { credentials: null, getAccountSettings });
  try {
    await run({ runtime, readSharedMetadata: () => JSON.parse(metadata), persistedWrites: () => writes, localWrites: () => localWrites });
  } finally {
    try {
      await runtime.mcp.close();
      await daemon.close();
    } finally { restore(); await app.close(); }
  }
}

function resetEnvironment() {
  process.env = { ...env };
  delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  resetActiveAccountSettingsSnapshotForTests();
}

function unmockCaseModules() {
  vi.doUnmock('@/session/actions/createCliActionExecutorHarness');
  vi.doUnmock('@/mcp/server/registerHappierMcpBuiltInTools');
  vi.doUnmock('@/discussions/discussionActionDeps');
  vi.doUnmock('@/api/accountServerActionDeps');
  vi.doUnmock('@/api/sessionFollowActionDeps');
}

describe('createHappierMcpServer real host admission', () => {
  // These cases create fresh clients/transports and restore their HTTP adapter.
  // No module mocks change between them. Load the real graph during collection,
  // so compilation cannot outlive a test and overlap its HTTP adapter lifetime.
  beforeEach(resetEnvironment);
  afterEach(unmockCaseModules);
  afterEach(() => vi.restoreAllMocks());

  it('discovers complete widget and Board inputs over MCP and reads output schemas explicitly', async () => {
    const sessionId = 'c666666666666666666666666';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => createTestMetadata() });
    const runtime = createHappierMcpServer({
      sessionId, getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {}, getMetadataSnapshot: () => createTestMetadata(), ...catalogHostTurn,
    });
    const client = new Client({ name: 'widget-spec-discovery', version: '1' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.find(tool => tool.name === 'action_spec_get')?.inputSchema.properties)
        .toHaveProperty('includeOutputSchema');
      expect(tools.tools.find(tool => tool.name === 'action_spec_get')?.inputSchema.properties)
        .toHaveProperty('schemaPath');
      const readDefinition = async (id: string, includeOutputSchema = false) => {
        const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_spec_get', arguments: { id, includeOutputSchema } }));
        expect(reply.isError, id).not.toBe(true);
        const text = reply.content.find(content => content.type === 'text');
        if (!text || text.type !== 'text') throw new Error('Missing discovery result');
        expect(text.text.length, id).toBeLessThan(50000);
        const payload: unknown = JSON.parse(text.text);
        const result = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(payload);
        const definition = ActionDiscoveryDefinitionV1Schema.parse(result.actionSpec);
        for (const entry of result.schemaSections ?? []) {
          const part = CallToolResultSchema.parse(await client.callTool({ name: 'action_spec_get', arguments: { id, schemaPath: entry.path } }));
          const partText = part.content.find(content => content.type === 'text');
          if (!partText || partText.type !== 'text') throw new Error('Missing schema section');
          expect(partText.text.length, entry.path).toBeLessThan(50000);
          const section = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(JSON.parse(partText.text)).schemaSection;
          if (!section) throw new Error('Missing schema section');
          const [root, , name] = entry.path.slice(1).split('/');
          const schema = root === 'inputSchema' ? definition.inputSchema : definition.outputSchema;
          if (!schema || !name) throw new Error('Unknown schema root');
          const definitions = schema.definitions && typeof schema.definitions === 'object' ? schema.definitions : {};
          schema.definitions = { ...definitions, [name.replace(/~1/g, '/').replace(/~0/g, '~')]: section.schema };
        }
        return definition;
      };
      for (const id of ['widgets.catalog.list', 'boards.apply', 'home.hub.layout.update', 'session.board.item.upsert'] as const) {
        const definition = await readDefinition(id);
        expect(definition.id).toBe(id);
        expect(definition.outputSchema).toBeUndefined();
        const validate = new Ajv({ strict: false }).compile(definition.inputSchema);
        expect(validate({}), id).toBe(false);
        if (id === 'boards.apply') {
          const input = { boardId: 'board-1', intent: { kind: 'update', boardId: 'board-1', patch: { name: 'Renamed' } } };
          expect(getActionSpec(id).inputSchema.safeParse(input).success).toBe(true);
          expect(validate(input)).toBe(true);
          expect(validate({ ...input, intent: { ...input.intent, kind: 'unknown' } })).toBe(false);
        }
        if (id === 'home.hub.layout.update') {
          const input = { intent: { kind: 'visibility', sectionId: 'machines', hidden: false } };
          expect(getActionSpec(id).inputSchema.safeParse(input).success).toBe(true);
          expect(validate(input)).toBe(true);
          expect(validate({ intent: { ...input.intent, hidden: 'false' } })).toBe(false);
        }
        if (id === 'session.board.item.upsert') {
          const input = { sessionId, itemId: 'discovered-note', expectedItemRevision: null, item: { v: 1, title: 'Note', frame: 'card',
            height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative', document: {
              version: 1, root: { kind: 'stack', children: [{ kind: 'text', text: 'Complete schema' }] },
            } } } };
          expect(getActionSpec(id).inputSchema.safeParse(input).success).toBe(true);
          expect(validate(input)).toBe(true);
          expect(validate({ ...input, item: { ...input.item, title: 42 } })).toBe(false);
          expect(validate({ ...input, item: { ...input.item, source: { ...input.item.source,
            document: { version: 1, root: { kind: 'unknown' } },
          } } })).toBe(false);
        }
      }
      const full = await readDefinition('widgets.catalog.list', true);
      expect(full.outputSchema).toBeDefined();
      expect(new Ajv({ strict: false }).compile(full.outputSchema!)({})).toBe(false);
    } finally { await client.close(); await runtime.mcp.close(); await daemon.close(); }
  });

  it('publishes client-compilable tools before the successor runner has a turn witness', async () => {
    const sessionId = 'c444444444444444444444444';
    const runtime = createHappierMcpServer({
      sessionId,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getMetadataSnapshot: () => createTestMetadata(),
    });
    const client = new Client({ name: 'successor-runner-discovery', version: '1' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.mcp.connect(serverTransport);
      await client.connect(clientTransport);
      // The SDK compiles every advertised output schema, as the stdio bridge does.
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toContain('action_spec_get');
      await expect(runtime.executeTool({ toolName: 'action_spec_get', args: { id: 'session.board.get' } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    } finally {
      await client.close();
      await runtime.mcp.close();
    }
  });

  it('re-attaches discoverable Happier MCP through the real planned runner restart and bridge factory', async () => {
    // Daemon IPC and process signalling are genuine external boundaries. All
    // restart guards, bridge resolution, MCP factories and SDK discovery stay real.
    vi.spyOn(daemonControlClient, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const sessionId = 'c555555555555555555555555';
    const app = fastify();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: getTestServerBinding().serverUrl });
    const metadata = createTestMetadata({ machineId: 'machine-1', path: '/repo' });
    const secret = new Uint8Array(32).fill(17);
    const credentials = { token: 'successor-input-account', encryption: { type: 'legacy' as const, secret } };
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }));
    app.get('/v2/sessions/:sessionId', async () => ({ session: createSessionRecordFixture({
      id: sessionId, active: true, encryptionMode: 'e2ee', metadata: encodeBase64(encrypt(secret, 'legacy', metadata)),
    }) }));
    const admitted: Parameters<NonNullable<import('@/api/session/sessionClient').ApiSessionClientOptions['machineAdmissionTransport']>>[0][] = [];
    const machineAdmissionTransport = async (request: typeof admitted[number]) => {
      admitted.push(request);
      return { status: 'accepted' as const, localId: request.localId };
    };
    const session = {
      sessionId,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
      getMetadataSnapshot: () => metadata,
      getPermissionMode: () => 'yolo' as const,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
      getServerFeaturesSnapshot: () => ({ status: 'ready' as const, provenance: 'authenticated' as const,
        features: FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, board: { enabled: true } } }, capabilities: {} }) }),
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon', pid: 4242, happySessionId: sessionId,
      processCommandHash: 'predecessor-command', processStartTimeMs: 12345,
      processCommand: 'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
      vendorResumeId: 'claude-thread-1',
      spawnOptions: { directory: '/repo', resume: 'claude-thread-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' } },
    };
    const launch = () => resolveRunnerMcpServers({
      session, credentials,
      accountCredentials: null, accountSettings: null, machineId: 'machine-1', directory: '/repo',
    });
    let bridge = await launch();
    const discover = async () => {
      const client = new Client({ name: 'restart-discovery', version: '1' }, { capabilities: {} });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(bridge.happierMcpServer.url)));
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['action_spec_get', 'session_board_item_upsert']));
        const refused = await client.callTool({ name: 'session_board_get', arguments: {} });
        expect(refused).toMatchObject({ isError: true });
        expect(refused.content).toContainEqual({ type: 'text', text: expect.stringContaining('target_unavailable') });
        // CLI is an independent Account producer, not the Session runner's
        // authority. Exercise its actual executor and E2EE Machine admission.
        const cli = createCliActionExecutorFromCredentials({ credentials, ...getTestServerBinding(),
          serverApiUrl: getTestServerBinding().serverUrl, machineAdmissionTransport,
          pluginActionExecutionOwner: 'current_process',
          actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
          resolveServerFeaturesSnapshot: session.getServerFeaturesSnapshot,
        });
        const sent = await cli.execute('session.message.send',
          { sessionId, message: 'successor input', localId: 'successor-input' },
          { surface: 'cli', actionCaller: { kind: 'host' } });
        expect(sent).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'successor-input' } });
        expect(admitted).toEqual([expect.objectContaining({ sessionId, targetMachineId: 'machine-1', localId: 'successor-input' })]);
        const content = admitted[0]?.content;
        if (content?.t !== 'encrypted') throw new Error('Expected protected E2EE input');
        expect(decrypt(secret, 'legacy', Uint8Array.from(Buffer.from(content.c, 'base64')))).toMatchObject({
          content: { type: 'text', text: 'successor input' },
          meta: { happierProvenanceV1: { kind: 'cli' } },
        });
      } finally { await client.close(); }
    };
    try {
      const previousUrl = bridge.happierMcpServer.url;
      const result = await restartSessionRunnerOnCurrentRuntime({
        request: { sessionId, mode: 'if_stale', reason: 'daemon_restart_session_runners_command' },
        tracked,
        currentIdentity: { status: 'known', source: 'launch_spec', comparableId: 'version:0.2.11', entrypointVersion: '0.2.11' },
        requestRestart: input => requestPlannedRunnerRestart({
          ...input, deferral: { kind: 'none' }, restartRequestedPids: new Set(),
          pidToTrackedSession: new Map([[tracked.pid, tracked]]),
          isProcessSafeToSignal: async () => true,
          requestSignal: async request => {
            if (!await request.shouldSignal()) return { status: 'skipped_stale_owner' };
            bridge.happierMcpServer.stop();
            bridge = await launch();
            return { status: 'requested' };
          },
        }),
      });
      expect(result).toMatchObject({ ok: true, status: 'restarted', sessionId });
      expect(bridge.happierMcpServer.url).not.toBe(previousUrl);
      expect(bridge.mcpServers.happier.args).toContain(bridge.happierMcpServer.url);
      await discover();
    } finally { bridge.happierMcpServer.stop(); restoreHttp(); await app.close(); }
  });

  it('keeps descriptive catalog reads at the bound Session host policy owner', async () => {
    delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    const sessionId = 'c111111111111111111111111';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId,
      readMetadata: () => ({ ...createTestMetadata(), work: { memoryEnabled: false } }),
    });
    const runtime = createHappierMcpServer({
      sessionId,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getMetadataSnapshot: () => ({ ...createTestMetadata(), work: { memoryEnabled: false } }),
      ...catalogHostTurn,
    });
    try {
      await expect(runtime.executeTool({ toolName: 'action_spec_get', args: { id: 'memory.search' } }))
        .resolves.toEqual(expect.objectContaining({ ok: true,
          result: expect.objectContaining({ actionSpec: expect.objectContaining({ id: 'memory.search' }) }),
        }));
      const search = await runtime.executeTool({ toolName: 'action_spec_search', args: { query: 'memory', limit: 100 } });
      expect(search).toEqual(expect.objectContaining({ ok: true }));
      if (search.ok) {
        const result = z.object({ actionSpecs: z.array(z.object({ id: z.string() })) }).parse(search.result);
        expect(result.actionSpecs.map((spec) => spec.id)).toContain('memory.search');
      }
    } finally { await runtime.mcp.close(); await daemon.close(); }
  });

  it.each(['plain', 'e2ee'] as const)('uses live Session memory choice for direct tools, discovery and generic write admission (%s)', async (mode) => {
    let memoryEnabled = true;
    const actionsSettingsV1 = { v: 1, actions: {
      'memory.remember': { toolExposureModes: { agent: 'direct' } },
      'memory.update': { toolExposureModes: { agent: 'direct' } },
      'memory.forget': { toolExposureModes: { agent: 'direct' } },
    } };
    const sessionId = 'c222222222222222222222222';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, mode,
      readMetadata: () => ({ ...createTestMetadata(), work: { memoryEnabled } }),
    });
    const client = {
      sessionId,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getMetadataSnapshot: () => ({ ...createTestMetadata(), work: { memoryEnabled } }),
      ...catalogHostTurn,
    };
    const runtime = createHappierMcpServer(client, { accountSettings: accountSettingsParse({ actionsSettingsV1 }) });
    const execute = (toolName: string, args: unknown) => runtime.executeTool({ toolName, args });
    try {
      expect(runtime.toolNames).toEqual(expect.arrayContaining(['memory_remember', 'memory_update', 'memory_forget']));
      await expect(execute('action_spec_get', { id: 'memory.remember' })).resolves.toEqual(expect.objectContaining({
        ok: true, result: expect.objectContaining({ actionSpec: expect.objectContaining({ id: 'memory.remember' }) }),
      }));
      memoryEnabled = false;
      for (const id of ['memory.remember', 'memory.update', 'memory.forget'] as const) {
        await expect(execute('action_spec_get', { id })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        await expect(execute('action_execute', { actionId: id, input: {} })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        await expect(execute(id.replace('.', '_'), {})).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
      }
      const search = await execute('action_spec_search', { query: 'memory', limit: 100 });
      expect(search).toEqual(expect.objectContaining({ ok: true }));
      if (search.ok) {
        const result = z.object({ actionSpecs: z.array(z.object({ id: z.string() })) }).parse(search.result);
        const ids = result.actionSpecs.map((spec) => spec.id);
        for (const id of ['memory.remember', 'memory.update', 'memory.forget']) expect(ids).not.toContain(id);
      }
      const refreshed = createHappierMcpServer(client, { accountSettings: accountSettingsParse({ actionsSettingsV1 }) });
      try {
        for (const name of ['memory_remember', 'memory_update', 'memory_forget']) expect(refreshed.toolNames).not.toContain(name);
        expect(refreshed.toolNames).toContain('change_title');
      } finally { await refreshed.mcp.close(); }
      memoryEnabled = true;
      await expect(execute('action_spec_get', { id: 'memory.remember' })).resolves.toMatchObject({
        ok: true, result: { actionSpec: { id: 'memory.remember' } },
      });
    } finally { await runtime.mcp.close(); await daemon.close(); }
  });

  it('refuses catalog disclosure when bound Session metadata is unavailable without restricting unbound Account discovery', async () => {
    const sessionId = 'c333333333333333333333333';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => null });
    try {
      await expect(daemon.executor.execute('action.spec.get', { id: 'memory.remember' }, { surface: 'mcp' }))
        .resolves.toEqual(expect.objectContaining({ ok: true }));
      expect(daemon.getSessionReads()).toBe(0);
      for (const actionId of ['action.spec.get', 'action.spec.search'] as const) {
        await expect(daemon.executor.execute(actionId, actionId === 'action.spec.get' ? { id: 'memory.remember' } : { query: 'memory' },
          { surface: 'agent', defaultSessionId: sessionId, actionCaller: { kind: 'host' } }))
          .resolves.toEqual(expect.objectContaining({ ok: false, errorCode: 'target_unavailable' }));
      }
    } finally { await daemon.close(); }
  });

  it('refuses native memory windows on credentialless Session-bound MCP before transport', async () => {
    const manager = new RpcHandlerManager({ scopePrefix: 'bound-session', encryptionMode: 'plain' });
    const requests: unknown[] = [];
    manager.registerHandler(RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, async request => {
      requests.push(request);
      return { v: 1, snippets: [], citations: [], externalSnippets: [] };
    });
    const runtime = createHappierMcpServer({ sessionId: 'bound-session', rpcHandlerManager: manager,
      updateMetadata() {}, getServerBinding: getTestServerBinding,
      ...catalogHostTurn,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
    }, { credentials: null, accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'memory.get_window': { toolExposureModes: { agent: 'direct' } },
    } } }) });
    try {
      expect(await runtime.executeTool({ toolName: 'memory_get_window', args: {
        machineId: 'machine-1', source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' },
        sourceItemId: 'message',
      } })).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
      expect(requests).toEqual([]);
    } finally { await runtime.mcp.close(); }
  });

  it.each(['mixed-corpus', 'documents-only', 'project'] as const)('keeps credentialless %s searches within the MCP-bound Session', async (selection) => {
    const manager = new RpcHandlerManager({ scopePrefix: 'bound-session', encryptionMode: 'plain' });
    const queries: unknown[] = [];
    manager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SEARCH, async (query: unknown) => {
      queries.push(query);
      return { v: 1, ok: true, documents: { state: 'ready' }, hits: [
        { sessionId: 'bound-session', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1, summary: 'readable', score: 1 },
        { sessionId: 'foreign-session', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1, summary: 'private transcript', score: 1 },
        { type: 'artifact', ref: { kind: 'doc', serverId: 'test-home', artifactId: 'doc-1' },
          revision: { headerVersion: 1, bodyVersion: 1 }, location: 'document', summary: 'private document', score: 1 },
      ] };
    });
    const runtime = createHappierMcpServer({
      sessionId: 'bound-session', rpcHandlerManager: manager, updateMetadata() {},
      getServerBinding: getTestServerBinding,
      ...catalogHostTurn,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
    }, { credentials: null, accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'memory.search': { toolExposureModes: { agent: 'direct' } },
    } } }) });
    try {
      const result = await runtime.executeTool({ toolName: 'memory_search', args: {
        query: { v: 1, query: 'private', scope: selection === 'project'
          ? { type: 'project', projectRef: { serverId: 'test-home', projectKey: 'payments' } } : { type: 'global' }, mode: 'deep',
          corpora: selection === 'mixed-corpus' ? ['sessions', 'documents'] : ['documents'] },
      } });
      if (selection === 'project') {
        expect(result).toMatchObject({ ok: false, errorCode: 'memory_project_scope_unsupported' });
      } else expect(result).toEqual({ ok: true, result: {
        v: 1, ok: true, hits: selection === 'mixed-corpus' ? [{ sessionId: 'bound-session', seqFrom: 1, seqTo: 1,
          createdAtFromMs: 1, createdAtToMs: 1, summary: 'readable', score: 1 }] : [], documents: { state: 'unavailable' },
      } });
      expect(queries).toHaveLength(selection === 'mixed-corpus' ? 1 : 0);
      expect(JSON.stringify(result)).not.toContain('private transcript');
      expect(JSON.stringify(result)).not.toContain('private document');
    } finally { await runtime.mcp.close(); }
  });

  it('returns the daemon authority refusal for an advertised Account Action from a session-scoped runtime', async () => {
    delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    const sessionId = 'session-account-authority';
    const runtime = createHappierMcpServer({
      sessionId,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getServerBinding: getTestServerBinding,
      getServerFeaturesSnapshot: () => ({
        status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }),
      }),
      getActiveTurnPermissionWitness: () => ({
        turnId: 'turn-account', inputId: 'input-account', userMessageSeq: 1, userMessageSeqs: [1],
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
      }),
    }, {
      authorityScope: 'session',
      sessionCredentials: { token: 'restricted-session-token', encryption: null },
    });
    const result = await runtime.executeTool({ toolName: 'action_execute', args: {
      actionId: 'notifications.notify_me', input: { message: 'Session notification' },
    } });
    expect(JSON.stringify(result)).toContain('target_unavailable');
    expect(JSON.stringify(result)).not.toContain('action_disabled');
    expect(JSON.stringify(result)).not.toContain('content_unavailable');
  });

  it.each([
    ['plain', false, 1, 2], ['e2ee', false, 1, 2], ['plain', true, 1, 2], ['e2ee', true, 1, 2],
    ['plain', false, 3, 0],
  ] as const)('admits a %s cross-session send from the real MCP host (background run: %s; starter depth: %s; turn depth: %s)', async (mode, backgroundRun, starterDepth, turnDepth) => {
    // Daemon IPC is a genuine external boundary: the daemon contributes no plugin tools here.
    vi.spyOn(daemonControlClient, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    const origin = 'http://cross-session-home.test';
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin });
    const secret = new Uint8Array(32).fill(17);
    const credentials = { token: 'cross-session-token', encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
    const targetId = 'target-session-b';
    const targetMetadata = {
      sessionCreationCorrespondenceV1: SessionCreationCorrespondenceV1Schema.parse({
        v: 1,
        sessionCreationTag: deriveSessionCreationTagV1({
          callerCreationNamespace: 'mcp-host-admission-test', creationKey: targetId,
        }),
        recipe: {
          execution: { machineId: 'target-machine', directory: { kind: 'path', path: '/repo' } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          modelSelection: null, profileId: null, requestedPermissionMode: null,
          agentModeId: null, configuration: null, connectedServices: null,
          capabilitySelection: null, transcriptStorage: null, terminal: null,
          agentSessionStartupInstructionsMarkerV1: null, checkout: null,
        },
      }),
    };
    const admitted: Parameters<NonNullable<import('@/api/session/sessionClient').ApiSessionClientOptions['machineAdmissionTransport']>>[0][] = [];
    const features = { status: 'ready' as const, provenance: 'authenticated' as const, features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) };
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode }));
    app.get('/v1/account/settings', async () => ({ settings: null, settingsVersion: 0 }));
    app.get('/v2/sessions/:sessionId', async () => ({ session: createSessionRecordFixture({
      id: targetId, active: true, encryptionMode: mode,
      metadata: mode === 'plain' ? JSON.stringify(targetMetadata) : encodeBase64(encrypt(secret, 'legacy', targetMetadata)),
    }) }));
    app.get('/v1/projects', async () => ({ projects: [] }));
    // Like ApiSessionClient, this carrier owns the transport on its prototype.
    // Only HTTP and authenticated Machine admission are substituted boundaries.
    class SessionCarrier {
      sessionId = 'source-session-a';
      rpcHandlerManager = new RpcHandlerManager({ scopePrefix: this.sessionId, encryptionMode: 'plain' });
      updateMetadata() {}
      async enqueueSessionEventCommitted() { return { persisted: true, delivered: true }; }
      getServerBinding() { return { serverId: 'cross-session-home', serverUrl: origin }; }
      getServerFeaturesSnapshot() { return features; }
      getPermissionMode() { return 'yolo' as const; }
      getWorkDepth() { return starterDepth; }
      getHostTurnWorkDepth(turnId: string) { return turnId === 'source-turn-a' ? turnDepth : undefined; }
      getBackendTarget() { return { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const; }
      getCurrentSessionLocation() { return { machineId: 'source-machine', path: '/repo' }; }
      getActiveTurnPermissionWitness() { return { turnId: 'source-turn-a', causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } }; }
      getMachineAdmissionTransport() {
        return async (request: typeof admitted[number]) => {
          admitted.push(request);
          return { status: 'accepted' as const, localId: request.localId };
        };
      }
    }
    const source = new SessionCarrier();
    let stop: (() => void) | undefined;
    const client = new Client({ name: 'cross-session-test', version: '1' }, { capabilities: {} });
    // The real daemon has one active Home. Session reads resolve that process
    // endpoint; the fixture must initialize it as well as the Session binding.
    const releaseHome = publishServerHttpRuntimeOrigin(origin, 'https');
    try {
      const runtime = backgroundRun ? null : createHappierMcpServer(source, { credentials });
      if (backgroundRun) {
        const signal = new AbortController().signal;
        const readRunWitness = (): import('@/plugins/runtime/invocation/services/types').AgentInvocationTurnAdmissionWitness => ({
          inputId: 'run-input', turnId: 'run-turn', userMessageSeq: 1, userMessageSeqs: [1],
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
        });
        const binding = await resolveRunnerMcpServers({
          session: source, credentials, accountSettings: accountSettingsParse({}),
          machineId: 'source-machine', directory: '/repo', resolvedMcpServers: {},
          executionRun: {
            runId: 'background-run-a', workDepth: 4, cwd: '/repo', signal, isCurrent: () => true,
            readActiveTurnAdmissionWitness: readRunWitness,
            // Provider/runtime boundary: the Run owns its live occurrence and turn.
            readCurrentRunOccurrence: () => ({
              runId: 'background-run-a', sidechainId: 'run-sidechain', occurrenceId: 'run-occurrence',
              runtimeLifetimeSignal: signal, isCurrent: () => true, readActiveTurnAdmissionWitness: readRunWitness,
            }),
          },
        });
        stop = binding.happierMcpServer.stop;
        await client.connect(new StreamableHTTPClientTransport(new URL(binding.happierMcpServer.url)));
      }
      const args = { actionId: 'session.message.send', input: { sessionId: targetId, message: 'Hello from A', localId: 'u1-send' } };
      const result = runtime
        ? await runtime.executeTool({ toolName: 'action_execute', args })
        : await client.callTool({ name: 'action_execute', arguments: args });
      expect(JSON.stringify(result)).toContain('accepted');
      expect(admitted).toHaveLength(1);
      const request = admitted[0]!;
      expect(request.targetMachineId).toBe('target-machine');
      const content = request.content.t === 'plain' ? request.content.v : decrypt(secret, 'legacy', Uint8Array.from(Buffer.from(request.content.c, 'base64')));
      // Protected admission facts travel inside the sealed record, not as a
      // caller-controlled field on the Machine transport envelope.
      const record = z.object({ meta: z.object({ happierInputRequestV1: SessionInputRequestSchema }) }).parse(content);
      expect(record.meta.happierInputRequestV1.sourceSession).toMatchObject({
        sourceSessionId: source.sessionId, sourceTurnId: backgroundRun ? 'run-turn' : 'source-turn-a',
      });
      expect(content).toMatchObject({
        content: { type: 'text', text: 'Hello from A' },
        meta: { happierProvenanceV1: {
          v: 1, kind: 'happierSession', sourceSessionId: source.sessionId, via: 'mcp',
          callerDepth: backgroundRun ? 4 : Math.max(starterDepth, turnDepth),
        } },
      });
      if (backgroundRun) {
        const start = await client.callTool({ name: 'action_execute', arguments: { actionId: 'execution.run.start', input: {
          sessionId: source.sessionId, intent: 'review', backendTarget: source.getBackendTarget(), instructions: 'Review the change',
          permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        } } });
        // Parent depth is 1, but this Run is at the limit (4): the real MCP ->
        // Action -> admission path must not start a child at the parent's depth.
        expect(JSON.stringify(start)).toContain('work_depth_exceeded');
      }
    } finally {
      await client.close();
      stop?.();
      releaseHome();
      restore();
      await app.close();
    }
  });

  it('refuses a child start from the exact host turn at depth four even when the Session started at zero', async () => {
    const client = {
      sessionId: 'depth-zero-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'depth-zero-session', encryptionMode: 'plain' }),
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => createTestMetadata({ path: '/repo', machineId: 'machine-a' }),
      getCurrentSessionLocation: () => ({ path: '/repo', machineId: 'machine-a' }),
      getBackendTarget: () => ({ kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const }),
      getPermissionMode: () => 'yolo' as const,
      getWorkDepth: () => 0,
      getHostTurnWorkDepth: (turnId: string) => turnId === 'depth-four-turn' ? 4 : undefined,
      getActiveTurnPermissionWitness: () => ({
        turnId: 'depth-four-turn',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const },
      }),
    } satisfies import('@/mcp/startHappyServer').HappyMcpSessionClient;
    const runtime = createHappierMcpServer(client, {
      credentials: null,
      accountSettings: accountSettingsParse({ workDepthLimit: 4 }),
    });
    const result = await runtime.executeTool({
      toolName: 'action_execute',
      args: { actionId: 'execution.run.start', input: {
        sessionId: client.sessionId,
        intent: 'delegate',
        backendTarget: client.getBackendTarget(),
        instructions: 'Start another worker.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'work_depth_exceeded' });
  });
});

describe('createHappierMcpServer', () => {
  // These existing fixtures replace imported collaborators with per-case mocks.
  // Keep their module isolation; unmocking alone cannot change cached imports.
  beforeEach(() => {
    vi.resetModules();
    resetEnvironment();
  });
  afterEach(unmockCaseModules);

  it('wires Account-server, Pool, and Follow owners into the authenticated in-session Agent host', async () => {
    const captured: { params?: Record<string, unknown>; overrides?: Record<string, unknown> } = {};
    const accountInputs: Array<Record<string, unknown>> = [];
    const followInputs: Array<Record<string, unknown>> = [];
    const machinePoolAction = vi.fn();
    const homeDomainAction = vi.fn();
    const sessionFollowGet = vi.fn();
    const resolveServerFeaturesSnapshot = vi.fn(() => ({
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: {
        features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_stable-home-identity' } },
      },
    }));

    vi.doMock('@/api/accountServerActionDeps', () => ({
      createAccountServerActionDeps: (input: Record<string, unknown>) => {
        accountInputs.push(input);
        return { machinePoolAction, homeDomainAction };
      },
    }));
    vi.doMock('@/api/sessionFollowActionDeps', () => ({
      createSessionFollowActionDeps: (input: Record<string, unknown>) => {
        followInputs.push(input);
        return { sessionFollowGet };
      },
    }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: Record<string, unknown>, overrides: Record<string, unknown>) => {
        captured.params = params;
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const credentials = { token: 'agent-account-token', encryption: null } as const;
    createHappierMcpServer({
      sessionId: 'sess_account_actions_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getServerBinding: () => ({
        serverId: 'session-home-b',
        serverUrl: 'https://session-home-b.example.test',
      }),
      getServerFeaturesSnapshot: resolveServerFeaturesSnapshot,
    } as any, { credentials });

    expect(accountInputs).toHaveLength(1);
    expect(followInputs).toHaveLength(1);
    expect(accountInputs[0]).toMatchObject({ token: credentials.token, credentials });
    expect(accountInputs[0]).toMatchObject({
      serverId: 'session-home-b',
      serverHttpBaseUrl: 'https://session-home-b.example.test',
    });
    expect((accountInputs[0]?.resolveServerFeaturesSnapshot as (() => unknown))()).toEqual(
      resolveServerFeaturesSnapshot.mock.results[0]?.value,
    );
    expect(followInputs[0]).toMatchObject({
      token: credentials.token,
      prepareSourceKeyAfterSet: expect.any(Function),
    });
    expect(accountInputs[0]?.serverId).toEqual(followInputs[0]?.serverId);
    expect(accountInputs[0]?.serverHttpBaseUrl).toEqual(followInputs[0]?.serverHttpBaseUrl);
    expect(captured.params).toMatchObject({ serverIdentityId: 'srv_stable-home-identity' });
    expect(captured.params?.resolveServerFeaturesSnapshot).toBeTypeOf('function');
    expect(accountInputs[0]).toMatchObject({ serverIdentityId: 'srv_stable-home-identity' });
    expect(followInputs[0]).toMatchObject({ serverIdentityId: 'srv_stable-home-identity' });
    expect(captured.overrides).toMatchObject({
      machinePoolAction,
      homeDomainAction,
      sessionFollowGet,
    });
  });

  it('keeps restricted runtime credentials Session-scoped while advertising daemon-owned Account Actions', async () => {
    const captured: { params?: Record<string, unknown>; overrides?: Record<string, unknown>; enabled?: (id: string) => boolean } = {};
    const accountOwner = vi.fn(() => ({}));
    const followOwner = vi.fn(() => ({}));
    const sessionList = vi.fn();
    vi.doMock('@/api/accountServerActionDeps', () => ({ createAccountServerActionDeps: accountOwner }));
    vi.doMock('@/api/sessionFollowActionDeps', () => ({ createSessionFollowActionDeps: followOwner }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: Record<string, unknown>, overrides: Record<string, unknown>) => {
        captured.params = params;
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: {} })) } };
      },
    }));
    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: (_server: unknown, params: { deps: { isActionEnabled: (id: string) => boolean } }) => {
        captured.enabled = params.deps.isActionEnabled;
        return { toolNames: [] };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const sessionCredentials = { token: 'restricted-session-token', encryption: null } as const;
    createHappierMcpServer({
      sessionId: 'restricted-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any, {
      sessionCredentials,
      credentials: null,
      authorityScope: 'session',
      sessionList,
    });

    expect(accountOwner).not.toHaveBeenCalled();
    expect(followOwner).not.toHaveBeenCalled();
    expect(captured.params).toMatchObject({ token: sessionCredentials.token });
    expect(captured.params).not.toHaveProperty('credentials');
    expect(captured.overrides?.sessionList).toBe(sessionList);
    expect(captured.enabled?.('session.title.set')).toBe(true);
    // Tool visibility is shared policy, while the daemon capability owns
    // Account authorization (the real refusal is exercised above).
    expect(captured.enabled?.('account.apiTokens.list')).toBe(true);
    expect(captured.enabled?.('machines.list')).toBe(true);
  });

  it('opens a Session-scoped runtime\'s own E2EE Board with its Session material and no Account credentials', async () => {
    const { default: fastify } = await import('fastify');
    const { installAxiosFastifyAdapter } = await import('@/testkit/http/axiosAdapter');
    const { FeaturesResponseSchema, projectSessionAccessCapabilitiesV1 } = await import('@happier-dev/protocol');
    const { sealSessionStoredContent } = await import('@/session/transport/encryption/sessionStoredContentCodec');
    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    // The only boundary replaced is the Home's HTTP transport.
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://runner-home.test' });
    const sessionKey = new Uint8Array(32).fill(41);
    const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' as const } };
    const rawSession = (id: string) => ({
      id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryptionMode: 'e2ee', metadata: 'opaque', metadataVersion: 1, dataEncryptionKey: null,
      agentState: null, agentStateVersion: 0,
      effectiveAccess: {
        v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
      },
      responsibleAccountId: null, responsibleAccount: null,
    });
    const layout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] };
    app.get('/v2/sessions/:sessionId', async (request) => ({
      session: rawSession((request.params as { sessionId: string }).sessionId),
    }));
    app.get('/v2/sessions/:sessionId/system-records/record', async () => ({
      record: {
        id: 'layout.v1:layout',
        address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
        content: sealSessionStoredContent({ ...crypto, payload: layout }),
        revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      },
    }));
    app.get('/v2/sessions/:sessionId/system-records', async () => ({ records: [], nextCursor: null, hasNext: false }));

    const runtime = createHappierMcpServer({
      sessionId: 'runner-session',
      getServerBinding: () => ({ serverId: 'runner-home', serverUrl: 'http://runner-home.test' }),
      ...catalogHostTurn,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      // The live Session client already holds this Session's key.
      getStoredContentEncryptionContext: () => crypto,
      getServerFeaturesSnapshot: () => ({
        status: 'ready' as const,
        provenance: 'authenticated' as const,
        features: FeaturesResponseSchema.parse({
          features: {
            // Conversations depend on Session sharing.
            sessions: { enabled: true, board: { enabled: true }, conversations: { enabled: true } },
            sharing: { session: { enabled: true } },
          },
          capabilities: {},
        }),
      }),
    } as any, {
      sessionCredentials: { token: 'runner-session-token', encryption: null },
      credentials: null,
      authorityScope: 'session',
    });

    try {
      const board = await runtime.executeTool({ toolName: 'session_board_get', args: {} });
      expect(JSON.stringify(board)).toContain('"title":"Overview"');
      expect(JSON.stringify(board)).not.toContain('not_authenticated');

      // The material answers only for the bound Session: another E2EE Session
      // stays closed instead of borrowing it or degrading to Plain.
      const foreign = await runtime.executeTool({
        toolName: 'session_board_get',
        args: { sessionId: 'other-session' },
      });
      expect(JSON.stringify(foreign)).not.toContain('"title":"Overview"');
    } finally {
      restore();
      await app.close();
    }
  });

  it('returns toolNames aligned with current MCP action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['agent'], disabledPlacements: [] },
      },
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient);
    expect(toolNames).not.toContain('review_start');
    expect(toolNames).not.toContain('subagents_plan_start');
    expect(toolNames).toContain('action_spec_search');
  });

  it('advertises server-backed Session Actions only when the exact Home enables them and the runtime is authenticated', async () => {
    const capturedEnablement: Array<(id: string) => boolean> = [];

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: (_server: unknown, params: { deps: { isActionEnabled: (id: string) => boolean } }) => {
        capturedEnablement.push(params.deps.isActionEnabled);
        return { toolNames: [] };
      },
    }));

    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const credentials = { token: 'agent-account-token', encryption: null } as const;
    const createClient = (boardEnabled: boolean, conversationsEnabled: boolean) => ({
      sessionId: `sess_server_backed_action_availability_${boardEnabled}_${conversationsEnabled}`,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getServerFeaturesSnapshot: () => ({
        status: 'ready' as const,
        provenance: 'authenticated' as const,
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: {
              enabled: true,
              board: { enabled: boardEnabled },
              conversations: { enabled: conversationsEnabled },
            },
            sharing: { enabled: true, session: { enabled: true } },
          },
          capabilities: {},
        }),
      }),
    });

    createHappierMcpServer(createClient(false, false) as any, { credentials });
    createHappierMcpServer(createClient(true, true) as any, { credentials });
    createHappierMcpServer(createClient(true, true) as any, { credentials: null });

    expect(capturedEnablement).toHaveLength(3);
    expect(capturedEnablement[0]?.('session.board.layout.update')).toBe(false);
    expect(capturedEnablement[1]?.('session.board.layout.update')).toBe(true);
    expect(capturedEnablement[2]?.('session.board.layout.update')).toBe(false);
    expect(capturedEnablement[0]?.('discussion.list')).toBe(false);
    expect(capturedEnablement[1]?.('discussion.list')).toBe(true);
    expect(capturedEnablement[2]?.('discussion.list')).toBe(false);
    expect(capturedEnablement[0]?.('session.list')).toBe(true);
  });

  it('uses account action settings for the in-session MCP tool registry when provided', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.list': { enabled: true, disabledSurfaces: ['agent'], disabledPlacements: [] },
      },
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_account_settings_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient, {
      sessionCredentials: { token: 'reviewed-session-policy', encryption: null },
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              toolExposureModes: {
                agent: 'direct',
              },
            },
          },
        },
      },
    } as any);

    expect(toolNames).toContain('session_list');
  });

  it('reads current account action settings when registered session-agent MCP tools run', async () => {
    let settings = accountSettingsParse({});
    await withTitleHost('c111111111111111111111112', () => settings, async fixture => withMcpClient(fixture.runtime, async client => {
      settings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
        'session.title.set': { enabled: false },
      } } });
      const denied = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'Denied' } }));
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('action_disabled');
      expect(fixture.persistedWrites()).toBe(0);
      settings = accountSettingsParse({});
      const accepted = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'Allowed' } }));
      expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
      expect(fixture.readSharedMetadata()).toMatchObject({ summary: { text: 'Allowed' } });
    }));
  });

  it('uses account action settings for in-session MCP approval policy when provided', async () => {
    const settings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'session.title.set': { approvalRequiredSurfaces: ['agent'] },
    } } });
    await withTitleHost('c111111111111111111111113', () => settings, async fixture => {
      const result = await fixture.runtime.executeTool({ toolName: 'change_title', args: { title: 'Unapproved title' } });
      expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      expect(fixture.persistedWrites()).toBe(0);
    });
  });

  it('executes native Agent tool calls through the live Session authority and policy owner', async () => {
    const sessionId = 'sess_native_agent_tool_1';
    const causalPermissionAuthority = {
      kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only',
    } as const;
    const operations: Array<Parameters<Parameters<typeof createSessionDaemonAuthorityFixture>[0]['execute']>[0]> = [];
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId, execute: async operation => {
      operations.push(operation);
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    } });
    const runtime = createHappierMcpServer(hostClient(sessionId, {
      getPermissionMode: () => 'yolo',
      getActiveTurnPermissionWitness: () => ({ turnId: 'native-turn', causalPermissionAuthority }),
      getActiveTurnAdmissionWitness: () => ({
        turnId: 'native-turn', inputId: 'native-input', userMessageSeq: 1, userMessageSeqs: [1],
        callerPermissionMode: 'yolo', causalPermissionAuthority,
        agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      }),
    }), { requiredDirectActionIds: ['session.transcript.get'], sessionInputVia: 'action' });
    try {
      await runtime.executeTool({ toolName: 'action_execute', args: {
        actionId: 'session.spawn_new', input: { prompt: 'Spawn a helper' },
      }, toolCallId: 'native_tool_call_1' });
      await runtime.executeTool({ toolName: 'session_transcript_get', args: { limit: 10 },
        toolCallId: 'native_tool_call_2' });
      expect(operations).toMatchObject([
        { kind: 'action.execute', actionId: 'session.spawn_new', input: { prompt: 'Spawn a helper' },
          toolCallId: 'native_tool_call_1', surface: 'agent', witness: { turnId: 'native-turn',
            callerPermissionMode: 'yolo', causalPermissionAuthority,
            agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } } },
        { kind: 'action.execute', actionId: 'session.transcript.get',
          input: { sessionId, limit: 10 }, toolCallId: 'native_tool_call_2', surface: 'agent' },
      ]);
    } finally { await runtime.mcp.close(); await daemon.close(); }
  });

  it('passes the live session backend target into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: any) => {
        captured.params = params;
        return {
          executor: {
            execute: vi.fn(async () => ({ ok: true, result: { ok: true } })),
          },
        };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_backend_target_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({ path: '/repo/current' }),
      getBackendTarget: () => ({
        kind: 'backend',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
      }),
    } as any);

    expect(captured.params).toBeDefined();
    expect(captured.params.getCurrentSessionBackendTarget()).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      sourceKind: 'configured',
      configuredBackendId: 'review-bot',
    });
  });

  it('suppresses retained memory hits outside the session bound to an unauthenticated MCP client', async () => {
    const captured: { overrides?: any } = {};
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (_params: unknown, overrides: any) => {
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer({
      sessionId: 'bound-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: {
        invokeLocal: async () => ({
          v: 1,
          ok: true,
          hits: [
            {
              sessionId: 'bound-session',
              seqFrom: 1,
              seqTo: 1,
              createdAtFromMs: 1,
              createdAtToMs: 1,
              summary: 'readable',
              score: 1,
            },
            {
              sessionId: 'revoked-session',
              seqFrom: 1,
              seqTo: 1,
              createdAtFromMs: 1,
              createdAtToMs: 1,
              summary: 'retained after revocation',
              score: 0.5,
            },
          ],
        }),
      },
      updateMetadata: () => {},
    } as any, { credentials: null } as any);

    await expect(captured.overrides.daemonMemorySearch({
      query: { v: 1, query: 'retained', scope: { type: 'global' }, mode: 'hints' },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      hits: [expect.objectContaining({ sessionId: 'bound-session' })],
    }));
  });

  it('rejects an unauthenticated memory window outside the MCP-bound Session before daemon RPC', async () => {
    const captured: { overrides?: any } = {};
    const invokeLocal = vi.fn(async () => ({ v: 1, snippets: [], citations: [] }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (_params: unknown, overrides: any) => {
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer({
      sessionId: 'bound-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal },
      updateMetadata: () => {},
    } as any, { credentials: null } as any);

    await expect(captured.overrides.daemonMemoryGetWindow({
      sessionId: 'other-session',
      seqFrom: 1,
      seqTo: 2,
    })).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(invokeLocal).not.toHaveBeenCalled();
  });

  it('passes live session location into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: any) => {
        captured.params = params;
        return {
          executor: {
            execute: vi.fn(async () => ({ ok: true, result: { ok: true } })),
          },
        };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_location_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({
        permissionMode: 'bypassPermissions',
        permissionModeUpdatedAt: 10,
      }),
      getCurrentSessionLocation: () => ({
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      }),
    } as any);

    expect(captured.params).toBeDefined();
    expect(captured.params.rawSession).toEqual({
      metadata: {
        permissionMode: 'bypassPermissions',
        permissionModeUpdatedAt: 10,
      },
      path: '/repo/current',
      host: 'leeroy-mbp',
      machineId: 'machine-1',
    });
  });





  it('dispatches registered tools using the agent surface (internal MCP)', async () => {
    const settings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'session.title.set': { disabledSurfaces: ['mcp'] },
    } } });
    await withTitleHost('c111111111111111111111114', () => settings, async fixture => withMcpClient(fixture.runtime, async client => {
      const accepted = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'Agent title' } }));
      expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
      expect(fixture.readSharedMetadata()).toMatchObject({ summary: { text: 'Agent title' } });
    }));
  });

  it('routes change_title through the action executor (so approvals/enablement apply)', async () => {
    const settings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'session.title.set': { enabled: false },
    } } });
    await withTitleHost('c111111111111111111111115', () => settings, async fixture => {
      const result = await fixture.runtime.executeTool({ toolName: 'change_title', args: { title: 'Must not commit' } });
      expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
      expect(fixture.persistedWrites()).toBe(0);
    });
  });

  it('commits a credentialless Session title through its daemon once without a redundant local write', async () => {
    await withTitleHost('c111111111111111111111116', () => accountSettingsParse({}), async fixture => {
      const path = process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
      if (!path) throw new Error('Expected the Session daemon authority path');
      const authority = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: 'c111111111111111111111116',
      });
      if (!authority) throw new Error('Expected current Session daemon authority');
      const probe = await fetch(`http://127.0.0.1:${authority.httpPort}/`, { method: 'HEAD' });
      expect(probe.status).toBe(404);
      await withMcpClient(fixture.runtime, async client => {
        const result = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'New title' } }));
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const text = result.content.find(block => block.type === 'text');
        expect(text?.type === 'text' ? JSON.parse(text.text) : null).toMatchObject({ success: true, title: 'New title' });
      });
      expect(fixture.readSharedMetadata()).toMatchObject({ summary: { text: 'New title' } });
      expect(fixture.persistedWrites()).toBe(1);
      expect(fixture.localWrites()).toBe(0);
    });
  });

});
