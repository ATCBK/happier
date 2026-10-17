import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { accountSettingsParse, SessionListQueryV1Schema, SessionListQueryResponseV1Schema } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';

const processIdentity = vi.hoisted(() => vi.fn());
// Only OS inspection and network transports are substituted. MCP, Session
// routing, credentialed execution, Session opening and projection stay real.
vi.mock('@/daemon/processIdentity', () => ({ readProcessIdentityByPid: processIdentity }));
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(['session.status.get', 'session.messages.recent.get'] as const)(
  'reads two children through the real Session MCP envelope and credentialed executor: %s', async actionId => {
  const sessionId = 'c123456789012345678901230';
  const children = ['c123456789012345678901231', 'c123456789012345678901232'];
  const serverId = 'session-read-home';
  const serverHttpBaseUrl = 'https://session-read.test';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'session-read-account' })).toString('base64url')}.signature`, encryption: null };
  const settings = accountSettingsParse({});
  const startContext = resolveCliAgentStartContextV1({ sessionId, machineId: 'read-machine', directory: '/workspace',
    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, metadata: {},
    starterDepth: 0, turnDepth: 0, callerPermissionMode: 'read-only', settings, roles: {} });
  if (!startContext) throw new Error('Missing canonical caller context fixture');
  const members = new Set(children);
  const row = (id: string) => ({ ...createSessionNotificationContextFixture(id), encryptionMode: 'plain' as const,
    metadata: '{}', active: true, reportsTo: { sessionId } });
  const command = 'node /runtime/.runner-snapshots/session-read/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23346,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:session-read' };
  processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    }) };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31001, capability: 'A'.repeat(43) });
  vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
  const httpReads: string[] = [];
  const queryRequests: unknown[] = [];
  const boundaryFailures: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    expect(config?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
    const pathname = new URL(String(url)).pathname;
    httpReads.push(pathname);
    if (pathname === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (pathname === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
    const target = children.find(id => pathname === `/v2/sessions/${id}`);
    if (target) return { status: 200, data: { session: row(target) } };
    const transcript = children.find(id => pathname === `/v1/sessions/${id}/messages`);
    if (transcript) return { status: 200, data: { messages: [{ id: `message-${transcript}`, seq: 1,
      localId: null, sidechainId: null, createdAt: 1, updatedAt: 1, messageRole: 'user',
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `Ready ${transcript}` } } },
    }], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null } };
    boundaryFailures.push(`Unexpected Session read: ${pathname}`);
    throw new Error(`Unexpected Session read: ${pathname}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    queryRequests.push({ url: String(url), body });
    expect(new URL(String(url)).pathname).toBe('/v2/sessions/query');
    const query = SessionListQueryV1Schema.parse(body);
    expect(query.underSessionId).toBe(sessionId);
    const response = SessionListQueryResponseV1Schema.safeParse({
      sessions: query.storage === 'active' ? [...members].map(row) : [],
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
    });
    if (!response.success) {
      boundaryFailures.push(JSON.stringify(response.error.issues));
      throw response.error;
    }
    return { status: 200, data: response.data };
  });
  const daemon = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
    serverId, serverHttpBaseUrl, pluginActionExecutionOwner: 'current_process' });
  const forwarded: string[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    if (!init?.body) { boundaryFailures.push(`Unexpected fetch: ${String(_url)}`); throw new Error('Unexpected bodyless fetch'); }
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context).toEqual({ token: 'A'.repeat(43), sessionId });
    if (request.operation.kind !== 'action.execute') throw new Error('Expected Action envelope');
    const operation = request.operation;
    expect(getActionSpec(operation.actionId).inputSchema.safeParse(operation.input).success).toBe(true);
    forwarded.push(operation.actionId);
    const outcome = await daemon.execute(operation.actionId, operation.input, { surface: 'agent',
      authority: 'account_automation', defaultSessionId: sessionId, actionCaller: operation.witness.agentStartCaller,
      agentStartContext: startContext });
    return Response.json({ ok: true, result: { kind: 'action.execution', requestId: operation.requestId, outcome } });
  });
  const witness = { turnId: 'read-turn', inputId: 'read-input', userMessageSeq: 1, userMessageSeqs: [1],
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
  let admissionAvailable = true;
  const runtime = createHappierMcpServer({ sessionId,
    getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
    getActiveTurnAdmissionWitness: () => admissionAvailable ? witness : null,
    getActiveTurnPermissionWitness: () => ({ ...witness,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } }),
  }, { authorityScope: 'session' });
  const client = new Client({ name: 'session-read', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    for (const child of children) {
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId, input: { sessionId: child } } }));
      const content = result.content.find(block => block.type === 'text');
      if (content?.type !== 'text') throw new Error('Missing MCP Action result');
      const value: unknown = JSON.parse(content.text);
      expect(result.isError, JSON.stringify({ content, forwarded, httpReads, queryRequests, boundaryFailures })).not.toBe(true);
      expect(value).toMatchObject(actionId === 'session.status.get'
        ? { ok: true, session: { id: child }, awareness: { sessionId: child } }
        : { ok: true, sessionId: child, items: [{ kind: 'user_message', text: `Ready ${child}` }] });
    }
    expect(forwarded).toEqual(children.map(() => actionId));
    if (actionId === 'session.messages.recent.get') {
      for (const child of children) expect(httpReads).toContain(`/v1/sessions/${child}/messages`);
    }
    // Captured caller facts do not keep read authority after the Home removes
    // the child from the led subtree. The real query must be consulted again.
    members.delete(children[0]!);
    httpReads.length = 0;
    const refused = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
      arguments: { actionId, input: { sessionId: children[0] } } }));
    const refusal = refused.content.find(block => block.type === 'text');
    expect(refused.isError).toBe(true);
    expect(refusal?.type === 'text' ? JSON.parse(refusal.text) : null).toMatchObject({ errorCode: 'unsupported_action' });
    expect(httpReads).not.toContain(`/v2/sessions/${children[0]}`);
    admissionAvailable = false;
    const forwardedBefore = [...forwarded];
    const unbound = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
      arguments: { actionId, input: { sessionId: children[1] } } }));
    const unavailable = unbound.content.find(block => block.type === 'text');
    expect(unbound.isError).toBe(true);
    expect(unavailable?.type === 'text' ? JSON.parse(unavailable.text) : null).toMatchObject({ errorCode: 'target_unavailable' });
    expect(forwarded).toEqual(forwardedBefore);
  } finally {
    await client.close();
    await runtime.mcp.close();
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('A'.repeat(43)) });
  }
});
