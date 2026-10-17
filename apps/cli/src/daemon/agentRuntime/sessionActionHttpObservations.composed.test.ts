import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  accountSettingsParse, normalizeActionsSettingsV1, SessionListQueryV1Schema, SessionListQueryResponseV1Schema,
  type ActionsSettingsV1,
} from '@happier-dev/protocol';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { verifyExternalActionMachineRpcExecution } from '../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { parseSessionListQueryActionResultV1 } from '@happier-dev/protocol/sessions/awareness/action';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { auth } from '../../../../server/sources/app/auth/auth';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { installedSessionExternalActionStorage as storage } from '../../../../server/sources/app/api/testkit/installedSessionExternalActionStorage';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import type { Fastify } from '../../../../server/sources/app/api/types';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { prepareExternalActionRequesterAccountAuthorization, resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { createSessionListActionDependency } from '@/session/actions/sessionListActionDependency';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import { logger } from '@/ui/logger';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDaemonSessionAccountActionExecutor } from './createDaemonSessionAccountActionExecutor';
import { AgentRuntimeDaemonServiceRequestV1Schema, type AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from './sessionBridgeAuthorization';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const processIdentity = vi.hoisted(() => vi.fn());
vi.mock('@/daemon/processIdentity', () => ({ readProcessIdentityByPid: processIdentity }));

// Only database I/O and HTTP delivery are substituted. Home issuance, signature
// verification, Session custody, scope admission and the transport readers run.
vi.mock('../../../../server/sources/storage/db', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../server/sources/storage/db')>(),
  db: (await import('../../../../server/sources/app/api/testkit/installedSessionExternalActionStorage')).installedSessionExternalActionStorage.db,
}));

const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
const sessionId = 'c123456789012345678901230';
const childId = 'c123456789012345678901231';
const serverId = 'signed-session-home';
const serverHttpBaseUrl = 'https://signed-session.test';
type Operation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;

beforeAll(async () => {
  vi.stubEnv('HANDY_MASTER_SECRET', 'session-observation-test-secret');
  vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
  await auth.init();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });
afterAll(() => vi.unstubAllEnvs());

async function fixture(metadataLayout: 0 | 1 = 1) {
  storage.state.sessionId = sessionId;
  storage.state.bound = true;
  storage.state.publisherBound = true;
  storage.state.revokedAt = null;
  storage.state.publicKey = installation.publicKey;
  const token = await auth.createToken(storage.account.id, undefined, { kind: 'account', authority: 'present_user' });
  const credentials = { token, encryption: null };
  const scopeKey = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials));
  let rawSettings: { actionsSettingsV1?: ActionsSettingsV1 } = {};
  let settingsVersion = 0;
  const publishSettings = () => setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings, scopeKey,
    settingsVersion: ++settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [], promptLibraryCatalog: { status: 'loading' } });
  publishSettings();
  const actionsSettingsProvider = createActionSettingsProvider({ scopeKey });
  const app: Fastify = createAuthenticatedTestApp({ authentication: 'real' });
  app.decorate('resolveCurrentSessionMachine', async () => storage.state.bound ? storage.state.machineId : null);
  registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Unexpected external dispatch'); } });
  const observations: { method: string; path: string; status: number; code?: string; signed: boolean; bearer: boolean }[] = [];
  app.addHook('onSend', async (request, reply, payload) => {
    let code: string | undefined;
    if (reply.statusCode >= 400 && typeof payload === 'string') {
      const body: unknown = JSON.parse(payload);
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      if (error === 'invalid_token' || error === 'credential_scope_denied') code = error;
    }
    observations.push({ method: request.method, path: request.url, status: reply.statusCode,
      ...(code ? { code } : {}),
      signed: typeof request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'string',
      bearer: request.headers.authorization !== undefined });
    return payload;
  });
  const members = new Set([childId]);
  let currentnessRefused = false;
  let subtreeRefused = false;
  let callerWorkspaceMissing = false;
  let inactive = false;
  let childArchived = false;
  const lifecycleEffects: string[] = [];
  const row = (id: string) => {
    const metadata = { machineId: storage.state.machineId,
      ...(id === sessionId && callerWorkspaceMissing ? {} : { path: '/workspace' }), flavor: 'codex' };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Invalid caller metadata fixture');
    return { ...createSessionNotificationContextFixture(id), encryptionMode: 'plain' as const, share: null, active: !inactive,
      archivedAt: id === childId && childArchived ? 123 : null,
      ...(metadataLayout === 0 ? { metadata: JSON.stringify(metadata) } : {
        metadataLayoutVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
        ownerMetadata: { t: 'plain' as const, v: owner.ownerMetadata },
      }),
      ...(id === childId ? { reportsTo: { sessionId } } : {}) };
  };
  app.get('/v1/account/encryption/currentness', { preHandler: app.authenticate }, async (_request, reply) =>
    currentnessRefused ? reply.code(401).send({ error: 'private-error-body' }) : createAccountEncryptionCurrentnessFixture());
  app.get('/v2/account/settings', { preHandler: app.authenticate }, async () => ({ version: settingsVersion, content: { t: 'plain', v: rawSettings } }));
  app.get('/v1/artifacts', { preHandler: app.authenticate }, async () => []);
  app.get('/v1/account/entity-rows/acp', { preHandler: app.authenticate }, async () =>
    AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
      content: { t: 'plain', v: { v: 1, definitions: [] } } }));
  app.get('/v1/account/entity-rows/prompt-library', { preHandler: app.authenticate }, async () =>
    PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
      key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
    })) }));
  app.post('/v2/sessions/query', { preHandler: app.authenticate }, async (request, reply) => {
    const query = SessionListQueryV1Schema.parse(request.body);
    expect(query.underSessionId).toBe(sessionId);
    if (subtreeRefused) return reply.code(401).send({ error: 'private-error-body' });
    return SessionListQueryResponseV1Schema.parse({ sessions: query.storage === (childArchived ? 'archived' : 'active') ? [...members].map(row) : [],
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
  });
  app.get('/v2/sessions/:sessionId', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.status.get', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async request => ({ session: row((request.params as { sessionId: string }).sessionId) }));
  app.get('/v1/sessions/:sessionId/messages', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.messages.recent.get', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async () => ({ messages: [{ id: 'message-child', seq: 1, localId: null, sidechainId: null, createdAt: 1, updatedAt: 1,
    messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Child ready' } } } }],
    hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }));
  app.post('/v2/sessions/:sessionId/archive', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.archive', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async request => {
    lifecycleEffects.push(request.url);
    if ((request.params as { sessionId: string }).sessionId === childId) childArchived = true;
    return { success: true, archivedAt: 123 };
  });
  app.post('/v2/sessions/:sessionId/unarchive', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.unarchive', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async request => {
    lifecycleEffects.push(request.url);
    if ((request.params as { sessionId: string }).sessionId === childId) childArchived = false;
    return { success: true, archivedAt: null };
  });
  const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
  const prepare = async (operation: Pick<Operation, 'actionId' | 'input' | 'requestId'>,
    sessionActionOrigin: Parameters<typeof prepareExternalActionRequesterAccountAuthorization>[0]['sessionActionOrigin']) => {
    const target = { kind: 'machine' as const, machineId: storage.state.machineId };
    const authorization = await prepareExternalActionRequesterAccountAuthorization({ ...operation,
      target, machineId: storage.state.machineId, sourceMachineId: storage.state.machineId,
      accountId: storage.account.id, accountEncryptionMode: 'plain', tokenEpochHint: 1, token,
      serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
      installationId: storage.state.installationId, privateKey: installation.secretKey, sessionActionOrigin });
    if (!authorization) return null;
    ExternalActionExecutionAuthorizationV1Schema.parse(authorization);
    return { authorization, target };
  };
  const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl, token, credentials,
    machineId: storage.state.machineId,
    prepareExternalActionAuthorization: ({ operation, sessionActionOrigin }) => prepare(operation, sessionActionOrigin),
    createExecutor: () => {
      const executor = createCliActionExecutor({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
        externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId,
        actionsSettingsProvider,
      });
      return executor;
    },
  });
  const operation = (actionId: Operation['actionId'], input: Operation['input']): Operation => ({ kind: 'action.execute',
    actionId, input, requestId: 'signed-observation', surface: 'agent',
    witness: { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0, callerPermissionMode: 'default',
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } } });
  return { credentials, app, observations, members, prepare, execute, operation, actionsSettingsProvider, lifecycleEffects,
    setActionsSettings: (actionsSettingsV1: ActionsSettingsV1) => { rawSettings = { actionsSettingsV1 }; publishSettings(); },
    markInactive: () => { inactive = true; },
    markChildArchived: () => { childArchived = true; },
    refuseCurrentness: () => { currentnessRefused = true; },
    refuseSubtree: () => { subtreeRefused = true; },
    omitCallerWorkspace: () => { callerWorkspaceMissing = true; },
    close: async () => { restore(); await app.close(); } };
}

it.each(['session.stop', 'session.archive', 'session.unarchive'] as const)(
  'admits only fresh led lifecycle targets through MCP and signed Home admission: %s', async actionId => {
  const f = await fixture();
  f.markInactive();
  const lifecycleDiagnostics = vi.spyOn(logger, 'warnLocalFile');
  if (actionId === 'session.unarchive') f.markChildArchived();
  // Defaults stay disabled. Only this isolated in-memory Account fixture opts in.
  expect(await f.execute(f.operation(actionId, { sessionId: childId }), { sessionId, isCurrent: async () => true }))
    .toMatchObject({ ok: false, errorCode: 'action_disabled' });
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { disabledSurfaces: [] } } }));
  const command = 'node /runtime/.runner-snapshots/signed-lifecycle/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23347,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:signed-lifecycle' };
  processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    }) };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31002, capability: 'B'.repeat(43) });
  const previousAuthorityPath = process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
  process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = path;
  const stop = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ status: 'not_found' });
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context).toEqual({ token: 'B'.repeat(43), sessionId });
    if (request.operation.kind !== 'action.execute') throw new Error('Expected Action envelope');
    const outcome = await f.execute(request.operation, { sessionId, isCurrent: async () => true });
    return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
  });
  const witness = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1],
    callerPermissionMode: 'default',
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' },
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
  const runtime = createHappierMcpServer({ sessionId,
    getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
    getPermissionMode: () => 'default',
    getActiveTurnAdmissionWitness: () => witness,
    getActiveTurnPermissionWitness: () => witness,
  }, { authorityScope: 'session', actionsSettingsProvider: f.actionsSettingsProvider });
  const client = new Client({ name: 'signed-lifecycle', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const invoke = async (target: string) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
      arguments: { actionId, input: { sessionId: target } } }));
    const content = result.content.find(block => block.type === 'text');
    if (content?.type !== 'text') throw new Error('Missing MCP result');
    return { failed: result.isError === true, value: JSON.parse(content.text) as unknown };
  };
  const effectCount = () => stop.mock.calls.length + f.lifecycleEffects.length;
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    expect(effectCount()).toBe(0);
    for (const target of [sessionId, childId]) {
      const result = await invoke(target);
      expect(result.failed, JSON.stringify({ result, diagnostics: lifecycleDiagnostics.mock.calls,
        observations: f.observations.slice(-8) })).toBe(false);
      expect(result.value).toMatchObject(actionId === 'session.stop'
        ? { ok: true, sessionId: target, stopOutcome: { status: 'already_stopped' } }
        : { ok: true, sessionId: target, archivedAt: actionId === 'session.archive' ? 123 : null });
    }
    const signed = f.observations.filter(row => row.signed);
    expect(signed.some(row => row.path === '/v2/sessions/query')).toBe(true);
    expect(signed.every(row => row.status === 200 && !row.bearer), JSON.stringify(signed)).toBe(true);
    const targetReads = f.observations.filter(row => row.path === `/v2/sessions/${childId}`);
    expect(targetReads.length).toBeGreaterThan(0);
    expect(targetReads.every(row => row.signed && !row.bearer)).toBe(true);
    if (actionId === 'session.stop') {
      expect(stop).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.STOP_SESSION,
        request: { sessionId: childId }, externalAction: expect.objectContaining({ effectActionId: actionId }) }));
    } else {
      expect(f.observations).toContainEqual(expect.objectContaining({ path: `/v2/sessions/${childId}/${actionId === 'session.archive' ? 'archive' : 'unarchive'}`,
        status: 200, signed: true, bearer: false }));
    }
    const effects = effectCount();
    f.members.clear();
    expect(await invoke(childId)).toMatchObject({ failed: true, value: { errorCode: 'unsupported_action', details: { cause: 'target_outside_led_subtree' } } });
    expect(await invoke('c123456789012345678901239')).toMatchObject({ failed: true, value: { errorCode: 'unsupported_action' } });
    expect(effectCount()).toBe(effects);
    f.members.add(childId);
    f.setActionsSettings(normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } }));
    expect(await invoke(childId)).toMatchObject({ failed: true });
    expect(effectCount()).toBe(effects);
    f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { disabledSurfaces: [] } } }));
    storage.state.bound = false;
    expect(await invoke(childId)).toMatchObject({ failed: true });
    expect(effectCount()).toBe(effects);
  } finally {
    await client.close();
    await runtime.mcp.close();
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('B'.repeat(43)) });
    if (previousAuthorityPath === undefined) delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    else process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = previousAuthorityPath;
    await f.close();
  }
});

it.each([
  { actionId: 'session.status.get', metadataLayout: 0 },
  { actionId: 'session.messages.recent.get', metadataLayout: 0 },
  { actionId: 'session.status.get', metadataLayout: 1 },
  { actionId: 'session.messages.recent.get', metadataLayout: 1 },
] as const)(
  'admits fresh subtree observation through real caller resolution: $actionId, layout $metadataLayout', async ({ actionId, metadataLayout }) => {
  const f = await fixture(metadataLayout);
  try {
    const run = () => f.execute(f.operation(actionId, { sessionId: childId }), { sessionId, isCurrent: async () => true });
    const result = await run();
    expect(result, JSON.stringify({ result, observations: f.observations })).toMatchObject(actionId === 'session.status.get'
      ? { ok: true, result: { session: { id: childId } } }
      : { ok: true, result: { sessionId: childId, items: [{ text: 'Child ready' }] } });
    const queries = f.observations.filter(row => row.path === '/v2/sessions/query');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    f.members.clear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'target_outside_led_subtree' } });
    f.refuseSubtree();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'subtree_observation_unavailable' } });
    f.omitCallerWorkspace();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'caller_context_unavailable' } });
    expect(diagnostics).toHaveBeenCalledWith('[Session Account Action] Refused', expect.objectContaining({
      errorCode: 'unsupported_action', scopeFailureCause: 'caller_context_unavailable',
      refusalPhase: 'agent_start_context', refusalReason: 'caller_workspace_unavailable',
    }));
    expect(diagnostics).toHaveBeenCalledWith('[Session Account Action] Refused', expect.objectContaining({
      errorCode: 'unsupported_action', scopeFailureCause: 'subtree_observation_unavailable',
    }));
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private-error-body');
  } finally { await f.close(); }
});

it.each(['session.status.get', 'session.messages.recent.get', 'session.stop', 'session.archive', 'session.unarchive'] as const)(
  'signs the policy subtree read as %s at the production list owner', async actionId => {
  const f = await fixture();
  try {
    const op = f.operation(actionId, { sessionId: childId });
    const prepared = await f.prepare(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: op.requestId });
    if (!prepared) throw new Error('Missing original root');
    const list = createSessionListActionDependency({ credentials: f.credentials, serverId,
      serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
      resolveAccountSettings: () => accountSettingsParse({}),
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId });
    const query = SessionListQueryV1Schema.parse({ v: 1, storage: 'active', includeInactive: true,
      scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [], underSessionId: sessionId });
    const context = { surface: 'agent' as const, defaultSessionId: sessionId, serverId,
      externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target };
    const result = parseSessionListQueryActionResultV1(await list({ context, query }));
    expect(result, JSON.stringify(f.observations)).toMatchObject({ sessions: [{ id: childId }], hasNext: false });
    const signed = f.observations.filter(row => row.signed);
    expect(signed.length).toBeGreaterThan(0);
    expect(signed.every(row => row.status === 200 && !row.bearer)).toBe(true);
    for (const path of [`/v2/sessions/${childId}`,
      ...(actionId === 'session.messages.recent.get' ? [`/v1/sessions/${childId}/messages`] : [])]) {
      const authorization = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId, method: 'GET', path,
        daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!authorization.ok) throw new Error('Missing reader signature');
      const response = await f.app.inject({ method: 'GET', url: path, headers: authorization.headers });
      expect(response.statusCode, JSON.stringify(f.observations)).toBe(200);
    }
    if (actionId === 'session.stop' || actionId === 'session.archive' || actionId === 'session.unarchive') {
      const path = `/v2/sessions/${childId}/${actionId === 'session.archive' ? 'unarchive' : 'archive'}`;
      const body = {};
      const headers = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId,
        method: 'POST', path, body, daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!headers.ok) throw new Error('Missing lifecycle signature');
      expect((await f.app.inject({ method: 'POST', url: path, payload: body, headers: headers.headers })).statusCode).toBe(401);
    }
    if (actionId === 'session.stop' || actionId === 'session.archive') {
      const method = `${storage.state.machineId}:${RPC_METHODS.STOP_SESSION}`;
      const params = { sessionId: childId };
      const execution = { v: 1 as const, authorization: prepared.authorization, effectActionId: actionId,
        target: prepared.target, installationId: storage.state.installationId,
        machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: prepared.authorization.token,
          effectActionId: actionId, target: prepared.target, installationId: storage.state.installationId,
          method, requestId: op.requestId, params, privateKey: installation.secretKey }) };
      expect(await verifyExternalActionMachineRpcExecution(execution, { method, params, requestId: op.requestId,
        resolveCurrentSessionMachine: async () => storage.state.bound ? storage.state.machineId : null })).not.toBeNull();
      expect(await verifyExternalActionMachineRpcExecution(execution, { method,
        params: { sessionId: sessionId }, requestId: op.requestId,
        resolveCurrentSessionMachine: async () => storage.state.machineId })).toBeNull();
    }
    const signedQuery = async (body: unknown, effectActionId = op.actionId) => {
      const authorization = resolveExternalActionServerRequestHeaders({ context,
        effectActionId, method: 'POST', path: '/v2/sessions/query', body, daemonToken: f.credentials.token,
        serverIdentityId: storage.state.homeId, privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!authorization.ok) throw new Error('Missing query signature');
      return f.app.inject({ method: 'POST', url: '/v2/sessions/query', payload: body, headers: authorization.headers });
    };
    const { underSessionId: _root, ...unscopedQuery } = query;
    for (const [body, effect] of [[{ ...query, underSessionId: childId }, op.actionId],
      [unscopedQuery, op.actionId], [query, 'session.list']] as const) {
      const refused = await signedQuery(body, effect);
      expect(refused.statusCode).toBe(401);
      expect(refused.json()).toMatchObject({ error: 'invalid_token' });
    }
    storage.state.bound = false;
    expect((await signedQuery(query)).statusCode).toBe(401);
  } finally { await f.close(); }
});

it.each(['session.spawn_new', 'session.follow.sources.set', 'session.reports_to.set'] as const)(
  'uses the original %s root for post-commit source/destination transport reads', async actionId => {
  const f = await fixture();
  try {
    const sourceSessionId = actionId === 'session.reports_to.set' ? sessionId : childId;
    const destinationSessionId = actionId === 'session.reports_to.set' ? childId : sessionId;
    const operation = f.operation(actionId, actionId === 'session.spawn_new'
      ? { creationKey: 'signed-source-key-child', executionTarget: { serverId, machineId: storage.state.machineId },
        directory: { kind: 'path', path: '/workspace' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        reportsTo: { sessionId } }
      : actionId === 'session.follow.sources.set' ? { sourceSessionId, destinationSessionId }
        : { sessionId: sourceSessionId, leadSessionId: destinationSessionId, expectedLeadSessionId: null });
    const prepared = await f.prepare(operation, { v: 1, caller: operation.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: operation.requestId });
    expect(prepared, JSON.stringify(f.observations)).not.toBeNull();
    if (!prepared) throw new Error('Missing Home root');
    const context = { surface: 'agent' as const, defaultSessionId: sessionId, serverId,
      externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target };
    const preparation = createSessionFollowSourceKeyPreparationAfterSet({ credentials: f.credentials,
      effectActionId: actionId, serverHttpBaseUrl, serverIdentityId: storage.state.homeId,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId });
    expect(await preparation({ sourceSessionId, destinationSessionId, context }), JSON.stringify(f.observations))
      .toEqual({ kind: 'not_needed' });
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    f.refuseCurrentness();
    expect(await preparation({ sourceSessionId, destinationSessionId, context }))
      .toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'source_transport_exception' });
    expect(diagnostics).toHaveBeenCalledWith('[Session Follow source-key preparation] Transport refused', {
      cause: 'source_transport_exception', httpStatus: 401, errorCode: 'not_authenticated',
    });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private-error-body');
    // The root cannot be spent on unrelated Account operations or Session writes.
    for (const request of [{ method: 'GET', path: '/v2/account/settings' },
      { method: 'POST', path: `/v2/sessions/${sessionId}/archive` }]) {
      const headers = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId, ...request,
        daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!headers.ok) throw new Error('Missing signed headers');
      const response = await f.app.inject({ method: request.method as 'GET' | 'POST', url: request.path, headers: headers.headers });
      expect(response.statusCode).toBe(401);
    }
  } finally { await f.close(); }
});
