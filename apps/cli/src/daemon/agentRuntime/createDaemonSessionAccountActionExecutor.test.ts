import axios from 'axios';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonSessionAccountActionExecutor } from './createDaemonSessionAccountActionExecutor';
import nacl from 'tweetnacl';
import { mintExternalActionExecutionAuthorization, projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionApprovalInputV1,
  verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionRequestEnvelopeV1Schema,
  ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  externalActionExecutionAuthorizationRequestSchemaForActionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { AccountSettingsSchema, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { prepareExternalActionRequesterAccountAuthorization } from '@/api/externalActionExecutionAuthorization';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createDaemonManagedMachineActionAdapter } from '../startup/managedMachineActionAdapter';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { tmpdir } from 'node:os';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { resolveExternalActionMachineTarget } from '../externalActions/reconcileExternalActionTarget';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '../externalActions/daemonExternalActionTargetResolver';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import * as installationStore from '@/daemon/identity/store';
import { RPC_METHODS, UiActionDispatchRequestV1Schema } from '@happier-dev/protocol';
import { requiresExactDaemonApprovalReplay, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { logger } from '@/ui/logger';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

type Operation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;
const operation: Operation = {
  kind: 'action.execute', requestId: 'request-1', actionId: 'notifications.notify_me', input: { message: 'Finished' },
  witness: { turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 2,
    agentStartCaller: { kind: 'session', sessionId: 'bob-session', starterDepth: 1, turnDepth: 2 } },
};

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function createHarness() {
  const delivered: unknown[] = [];
  let current: (() => Promise<boolean>) | undefined;
  const params = {
    serverId: 'alice-home', serverHttpBaseUrl: 'https://alice-home.test', token: 'alice-daemon-token',
    createExecutor: (_depth: (turnId?: string) => number | undefined, isCallerCurrent: () => Promise<boolean>) => {
      current = isCallerCurrent;
      return createActionExecutor({
        ...createCliActionDeps({ token: 'alice-daemon-token', sessionId: '', mode: 'plain', ctx: null }),
        // Account notification delivery is an external network boundary.
        notificationsNotifyMe: async (input, context) => {
          delivered.push({ input, context });
          return { attemptedChannels: 1, deliveredChannels: 1 };
        },
      });
    },
  };
  return { execute: createDaemonSessionAccountActionExecutor(params), delivered,
    isCallerCurrent: () => current?.() };
}

describe('daemon Session Account authority', () => {
  it('requires original Home creator proof before a Session visual can use Account execution', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'alice-home',
      serverHttpBaseUrl: 'https://alice-home.test', token: 'alice-daemon-token',
      createExecutor: () => createActionExecutor(createCliActionDeps({ token: 'alice-daemon-token', sessionId: '', mode: 'plain', ctx: null })),
    });
    const visual: Operation = { ...operation, actionId: 'session.board.item.upsert', input: { itemId: 'visual', expectedItemRevision: null,
      destination: 'transcript', item: { v: 1, title: 'Visual', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'hello' } } } } } };
    expect(await execute(visual, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
        details: { reason: 'external_authorization_missing' } });
  });

  it('refuses a Session visual proof addressed to a Machine instead of its caller Session', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const serverHttpBaseUrl = 'https://visual-home.test';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 200, data: { v: 1, token: 'visual-home-proof', binding: {
        serverIdentityId: 'srv_visual', accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', machineId: 'machine', installationId: 'installation', actionId: 'session.board.item.upsert',
        requestId: request.envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        target: request.envelope.target, sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } } };
    });
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'visual-profile', serverHttpBaseUrl, token,
      prepareExternalActionAuthorization: async ({ operation: action, sessionActionOrigin }) => {
        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId: action.actionId, input: action.input,
          requestId: action.requestId, target, machineId: 'machine', sourceMachineId: 'machine', accountId: 'owner',
          accountEncryptionMode: 'plain', tokenEpochHint: 0, token, serverId: 'visual-profile', serverIdentityId: 'srv_visual',
          serverHttpBaseUrl, installationId: 'installation', privateKey: keys.secretKey, sessionActionOrigin });
        return authorization ? { authorization, target } : null;
      },
      createExecutor: () => createActionExecutor(createCliActionDeps({ token, sessionId: '', mode: 'plain', ctx: null })),
    });
    const visual: Operation = { ...operation, actionId: 'session.board.item.upsert', input: { itemId: 'visual', expectedItemRevision: null,
      destination: 'transcript', item: { v: 1, title: 'Visual', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'hello' } } } } } };
    expect(await execute(visual, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
        details: { reason: 'external_authorization_binding_mismatch' } });
  });

  it.each(['client', 'visual', 'relation', 'relation-server-error', 'unsigned-visual', 'unsigned-server-error', 'unsigned-retired', 'unsigned-revoked', 'unsigned-foreign-home', 'unsigned-unavailable'] as const)(
    'replays an installed Session %s Action only while its original Machine authority remains current', async kind => {
    const unsigned = kind.startsWith('unsigned-');
    const relation = kind.startsWith('relation');
    const serverHttpBaseUrl = 'https://client-source.test';
    const homeId = 'srv_client-source';
    const source = { machineId: 'source-machine', installationId: 'source-installation' };
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'source-account', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    // Installation-file reads and Home HTTP are genuine boundaries; all signing,
    // Session custody, approval policy/currentness and reverse delivery stay real.
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
      version: 1, installationId: source.installationId, createdAt: 1,
      publicKey: Buffer.from(keys.publicKey).toString('base64url'),
      privateKey: Buffer.from(keys.secretKey).toString('base64url'),
    });
    const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {
      'session.board.item.upsert': { approvalRequiredSurfaces: ['agent'] },
      'session.reports_to.set': { approvalRequiredSurfaces: ['agent'] },
    } } });
    setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const actionId = kind === 'client' ? 'relay.runtime.open_path' as const
      : relation ? 'session.reports_to.set' as const : 'session.board.item.upsert' as const;
    const input = relation ? { sessionId: 'bob-session', leadSessionId: 'lead-session', expectedLeadSessionId: null }
      : kind === 'client' ? { path: '/home/user/.happier/logs/runtime.log' } : {
      itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item: {
        v: 1, title: 'Visual', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Approved visual' } } },
      },
    };
    const target = kind === 'client' || relation ? { kind: 'machine' as const, machineId: source.machineId }
      : { kind: 'session' as const, sessionId: 'bob-session' };
    const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const mutations: unknown[] = [];
    const rawSession = createSessionRecordFixture({ id: 'bob-session', share: null,
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId: source.machineId, permissionMode: 'default' }),
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
    const rows = new Map<string, Record<string, unknown>>();
    const mintedRequests: unknown[] = [];
    let currentHomeId = homeId;
    let sessionCurrent = true;
    let accountCurrent = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, board: { enabled: true } } },
      capabilities: { serverIdentity: { serverIdentityId: currentHomeId } },
    })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      expect(new URL(String(url)).origin).toBe(serverHttpBaseUrl);
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: settings }, version: 1 } };
      if (path.startsWith('/v1/artifacts/')) return { status: rows.has(path.split('/').at(-1)!) ? 200 : 404,
        data: rows.get(path.split('/').at(-1)!) };
      if (path === '/v2/sessions/bob-session') return { status: 200, data: { session: rawSession } };
      if (path === '/v2/sessions/lead-session') return { status: 200, data: { session: { ...rawSession, id: 'lead-session' } } };
      if (path === '/v2/sessions/bob-session/system-records/record') return { status: 200, data: { record: null } };
      throw new Error(`Unexpected client Action GET path ${path}`);
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      expect(new URL(String(config.url)).origin).toBe(serverHttpBaseUrl);
      if (config.method === 'POST' && new URL(String(config.url)).pathname === ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1)
        return accountCurrent ? { status: 200, data: { tokens: [] } }
          : { status: 403, data: { error: 'forbidden' } };
      if (config.method === 'PUT' && new URL(String(config.url)).pathname === '/v2/sessions/bob-session/board') {
        const body: unknown = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
        if (unsigned) {
          expect(config.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
          expect(config.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBeUndefined();
        } else expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'source-home-proof', effectActionId: actionId,
          target, installationId: source.installationId, requestId: operation.requestId, method: 'PUT',
          path: '/v2/sessions/bob-session/board', body,
          signature: String(config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(true);
        // HTTP is the boundary: the live serialization-aborted transaction
        // publishes a 500 and commits no Session item.
        if (kind === 'unsigned-server-error') return { status: 500, data: {
          error: 'Internal Server Error', message: 'could not serialize access due to concurrent update',
        } };
        mutations.push(body);
        return { status: 200, data: { operation: 'upsert_item', itemId: 'visual', outcome: 'created', itemRevision: revision } };
      }
      throw new Error(`Unexpected client Action request path ${new URL(String(config.url)).pathname}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      expect(new URL(String(url)).origin).toBe(serverHttpBaseUrl);
      const path = new URL(String(url)).pathname;
      if (path === '/v1/sessions/bob-session/reports-to') {
        expect(relation).toBe(true);
        expect(body).toEqual({ leadSessionId: 'lead-session', expectedLeadSessionId: null });
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'source-home-proof', effectActionId: actionId,
          target, installationId: source.installationId, requestId: operation.requestId, method: 'POST', path, body,
          signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(true);
        if (kind === 'relation-server-error') return { status: 500, data: {
          error: 'Internal Server Error', message: 'could not serialize access due to concurrent update',
        } };
        mutations.push(body);
        return { status: 200, data: { ok: true, sessionId: 'bob-session', leadSessionId: 'lead-session', attachedAt: 1 } };
      }
      if (path === '/v2/sessions/lookup-by-tags') {
        const tags: unknown = Reflect.get(body, 'tags');
        expect(tags).toEqual([expect.stringMatching(relation ? /^(bob|lead)-session$/ : /^bob-session$/)]);
        if (!Array.isArray(tags) || typeof tags[0] !== 'string') throw new Error('Invalid Session lookup tags');
        return { status: 200, data: { sessions: [{ ...rawSession, id: tags[0] }] } };
      }
      if (path.endsWith('/execution-authorization')) {
        const request = externalActionExecutionAuthorizationRequestSchemaForActionV1(actionId).parse(body);
        mintedRequests.push(request);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
        return { status: 200, data: { v: 1, token: 'source-home-proof', binding: {
          accountId: 'source-account', custodianAccountId: 'source-account', authentication: { kind: 'account', tokenEpoch: 0 },
          serverIdentityId: homeId, ...source, actionId, requestId: operation.requestId, target,
          accountEncryptionMode: 'plain', sessionActionOrigin: request.sessionActionOrigin,
          sessionActionSource: request.sessionActionSource, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } } };
      }
      if (path.endsWith('/verify')) {
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'source-home-proof', effectActionId: actionId,
          target, installationId: source.installationId, requestId: operation.requestId, method: 'POST', path, body,
          signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(true);
        return { status: 200, data: { ok: true } };
      }
      if (path === '/v1/artifacts') {
        const id = String(Reflect.get(body, 'id'));
        rows.set(id, { ...body, ownerAccountId: 'source-account', access: 'owner', encryptionMode: 'plain',
          publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
      }
      if (path.startsWith('/v1/artifacts/')) {
        const row = rows.get(path.split('/').at(-1)!)!;
        expect(Reflect.get(body, 'expectedHeaderVersion')).toBe(row.headerVersion);
        expect(Reflect.get(body, 'expectedBodyVersion')).toBe(row.bodyVersion);
        const headerVersion = Number(row.headerVersion) + 1;
        const bodyVersion = Number(row.bodyVersion) + 1;
        rows.set(String(row.id), { ...row, header: Reflect.get(body, 'header'), body: Reflect.get(body, 'body'), headerVersion, bodyVersion });
        return { status: 200, data: { success: true, headerVersion, bodyVersion } };
      }
      throw new Error(`Unexpected client Action path ${path}`);
    });
    const deliveries: ReturnType<typeof UiActionDispatchRequestV1Schema.parse>[] = [];
    let completeClient!: () => void;
    const clientCompleted = new Promise<void>(resolve => { completeClient = resolve; });
    const reverse = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      // Connected-client RPC is this slice's outer boundary. The paired UI test
      // owns the real receiver/native operation, not an in-process substitute here.
      callConnectedClientRpc: async (method, payload, options) => {
        expect(method).toBe(RPC_METHODS.UI_ACTION_EXECUTE);
        deliveries.push(UiActionDispatchRequestV1Schema.parse(payload));
        options.onIssued();
        await clientCompleted;
        return { ok: true, result: { v: 1, execution: { ok: true, result: { status: 'completed' } } } };
      },
    }));
    let executor!: ReturnType<typeof createCliActionExecutorFromCredentials>;
    const createExecutor = (getCurrentTurnWorkDepth: (turnId?: string) => number | undefined,
      isCallerCurrent: () => Promise<boolean>) => {
      const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
        machineId: source.machineId, serverId: configuration.activeServerId, serverApiUrl: serverHttpBaseUrl,
        isSessionCallerCurrent: async ({ caller }) => sessionCurrent && caller.sessionId === 'bob-session' && await isCallerCurrent() });
      if (!currentness) throw new Error('Missing credentialed currentness owner');
      executor = createCliActionExecutorFromCredentials({ credentials, machineId: source.machineId,
        serverId: configuration.activeServerId, serverApiUrl: serverHttpBaseUrl, serverIdentityId: homeId,
        externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: source.installationId,
        getCurrentTurnWorkDepth, isApprovalExecutionOriginCurrent: currentness,
        clientActionExecute: reverse, pluginActionExecutionOwner: 'current_process' });
      return executor;
    };
    const execute = createDaemonSessionAccountActionExecutor({ serverId: configuration.activeServerId, serverHttpBaseUrl,
      token: credentials.token,
      prepareExternalActionAuthorization: async admission => {
        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId, input, requestId: operation.requestId,
          target, machineId: source.machineId, sourceMachineId: source.machineId, accountId: 'source-account',
          accountEncryptionMode: 'plain', tokenEpochHint: 0, token: credentials.token,
          serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl,
          installationId: source.installationId, privateKey: keys.secretKey, sessionActionOrigin: admission.sessionActionOrigin,
          isCurrent: admission.isCallerCurrent, signal: admission.authority.signal });
        return authorization ? { authorization, target } : null;
      },
      createExecutor,
    });
    const mcp = unsigned ? createHappierMcpServer({
      sessionId: 'bob-session', getServerBinding: () => ({ serverId: configuration.activeServerId, serverUrl: serverHttpBaseUrl }),
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, board: { enabled: true } } }, capabilities: { serverIdentity: { serverIdentityId: homeId } },
      }) }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'bob-session', encryptionMode: 'plain' }),
      updateMetadata() {}, getMetadataSnapshot: () => createTestMetadata({ machineId: source.machineId, permissionMode: 'default' }),
      getCurrentSessionLocation: () => ({ machineId: source.machineId, path: '/workspace' }),
      getPermissionMode: () => 'default', getWorkDepth: () => 1,
      getHostTurnWorkDepth: () => kind === 'unsigned-unavailable' ? undefined : 2,
      getActiveTurnPermissionWitness: () => ({ turnId: operation.witness.turnId,
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
    }, { credentials, accountSettings: settings }) : null;
    let mcpClient: Client | null = null;
    if (mcp) onTestFinished(async () => { await mcpClient?.close(); await mcp.mcp.close(); });
    if (mcp) createExecutor(() => 2, async () => true);
    const callMcp = async () => {
      if (!mcp) throw new Error('Missing MCP factory');
      if (kind !== 'unsigned-visual' && kind !== 'unsigned-server-error') {
        return await mcp.executeTool({ toolName: 'session_board_item_upsert', args: input, toolCallId: 'unsigned-visual' });
      }
      mcpClient = new Client({ name: 'daemon-visual-agent', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcp.mcp.connect(serverTransport);
      await mcpClient.connect(clientTransport);
      await mcpClient.listTools();
      const result = await mcpClient.callTool({ name: 'session_board_item_upsert', arguments: input }, CallToolResultSchema);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ kind: 'approval_request_created', artifactId: expect.any(String) });
      return { ok: true as const, result: result.structuredContent };
    };
    let settled = false;
    const pending = (mcp ? callMcp()
      : execute({ ...operation, actionId, input, surface: 'mcp', witness: { ...operation.witness, callerPermissionMode: 'default' } },
        { sessionId: 'bob-session', isCurrent: async () => true })).then(result => { settled = true; return result; });
    if (kind === 'unsigned-unavailable') {
      expect(await pending).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      expect(rows.size).toBe(0);
      expect(mutations).toEqual([]);
      return;
    }
    await vi.waitFor(async () => {
      if (settled && rows.size === 0) {
        const result = await pending;
        expect(result.ok, JSON.stringify(result)).toBe(true);
      }
      expect(rows.size).toBe(1);
    });
    const artifactId = [...rows.keys()][0]!;
    const store = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createCliApprovalsArtifactStore({ credentials }));
    const open = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsGet({ artifactId, serverId: null }));
    if (!open || open.v !== 2) throw new Error('Missing Session approval origin');
    expect(open.executionOriginV1).toMatchObject({ serverId: configuration.activeServerId, serverIdentityId: homeId,
      machineId: source.machineId, authority: 'account_automation', surface: 'agent' });
    if (mcp) {
      expect(open.executionOriginV1.externalActionExecutionAuthorization).toBeUndefined();
      expect(open.executionOriginV1.externalActionInputSignature).toBeUndefined();
      expect(requiresExactDaemonApprovalReplay(open)).toBe(true);
      expect(mintedRequests).toEqual([]);
    } else {
      expect(requiresExactDaemonApprovalReplay(open)).toBe(true);
      if (!open.executionOriginV1.externalActionInputSignature) throw new Error('Missing signed client approval origin');
      expect(open.executionOriginV1).toMatchObject({ accountId: 'source-account', requestId: operation.requestId, target });
      expect(verifyExternalActionApprovalInputV1({ authorizationToken: 'source-home-proof', actionId, input: open.actionArgs, target,
        signature: open.executionOriginV1.externalActionInputSignature, publicKey: keys.publicKey })).toBe(true);
      expect(mintedRequests).toEqual([expect.objectContaining({ sessionActionSource: source, installationProof: expect.any(Object) })]);
    }
    expect(deliveries).toEqual([]);
    expect(mutations).toEqual([]);
    if (kind === 'client') expect(settled).toBe(false);
    else expect(await pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId } });
    // The approving device writes the strict approved Artifact, then calls the
    // actual public replay RPC with its authenticated human transport authority.
    expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsUpdate({ artifactId, serverId: null,
      request: { ...open, status: 'approved', updatedAtMs: open.updatedAtMs + 1,
        decision: { kind: 'approve', decidedAtMs: open.updatedAtMs + 1 } } }))).toEqual({ ok: true });
    const rpc = new RpcHandlerManager({ scopePrefix: source.machineId, localMachineId: source.machineId,
      encryptionMode: 'plain', logger: () => {}, authorizeRequest: async () => ({ ok: true }) });
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor });
    if (kind === 'unsigned-retired') sessionCurrent = false;
    if (kind === 'unsigned-revoked') accountCurrent = false;
    if (kind === 'unsigned-foreign-home') currentHomeId = 'srv_foreign-home';
    const replay = await rpc.handleRequest({ method: `${source.machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`,
      params: { artifactId }, callerAuthority: 'present_user' });
    expect(replay).toMatchObject({ ok: true });
    if (kind === 'unsigned-server-error' || kind === 'relation-server-error') {
      const errorCode = relation ? 'action_failed' : 'server_error';
      expect(replay).toMatchObject({ result: { status: 'failed', execution: { ok: false, errorCode } } });
      expect(mutations).toEqual([]);
      expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsGet({ artifactId, serverId: null })))
        .toMatchObject({ status: 'failed', execution: { ok: false, errorCode } });
      return;
    }
    if (unsigned && kind !== 'unsigned-visual') {
      expect(replay).toMatchObject({ result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } } });
      expect(mutations).toEqual([]);
      expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsGet({ artifactId, serverId: null })))
        .toMatchObject({ status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } });
      return;
    }
    if (kind !== 'client') {
      const outcome = Reflect.get(replay as object, 'result');
      expect(Reflect.get(outcome, 'status'), JSON.stringify(Reflect.get(outcome, 'execution'))).toBe('executed');
      if (relation) {
        expect(replay).toMatchObject({ result: { status: 'executed', execution: { ok: true, result: {
          ok: true, sessionId: 'bob-session', leadSessionId: 'lead-session', attachedAt: 1,
        } } } });
        expect(mutations).toEqual([{ leadSessionId: 'lead-session', expectedLeadSessionId: null }]);
      } else {
        expect(replay).toMatchObject({ result: { status: 'executed', execution: { ok: true, result: {
          sessionId: 'bob-session', result: { itemId: 'visual', itemRevision: revision, outcome: 'created' },
        } } } });
        expect(mutations).toEqual([expect.objectContaining({ itemId: 'visual', itemContent: { t: 'plain', v:
          expect.objectContaining({ destination: 'transcript', source: {
            kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Approved visual' } },
          } }) } })]);
      }
      expect(await rpc.handleRequest({ method: `${source.machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`,
        params: { artifactId }, callerAuthority: 'present_user' })).toMatchObject({ ok: true });
      expect(mutations).toHaveLength(1);
      expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsGet({ artifactId, serverId: null })))
        .toMatchObject({ status: 'executed', execution: { ok: true } });
      expect(open.executionOriginV1.caller).toEqual(operation.witness.agentStartCaller);
      return;
    }
    await vi.waitFor(async () => {
      expect(settled ? await pending : null).toBeNull();
      expect(deliveries).toHaveLength(1);
    });
    expect(deliveries[0]).toMatchObject({ actionId, input, context: { surface: 'agent', authority: 'account_automation',
      defaultSessionId: 'bob-session', defaultSessionMachineId: source.machineId, actionRequestId: operation.requestId,
      actionCaller: operation.witness.agentStartCaller, externalActionTarget: target } });
    expect(settled).toBe(false);
    completeClient();
    expect(await pending).toEqual({ ok: true, result: { status: 'completed' } });
    expect(await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.approvalsGet({ artifactId, serverId: null })))
      .toMatchObject({ status: 'executed', execution: { ok: true, result: { status: 'completed' } } });
  });

  it('binds a native client Home approval to the authenticated daemon Machine without public API authorization', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    let persisted: ApprovalRequest | undefined;
    let delivered = 0;
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'alice-home', serverHttpBaseUrl: 'https://alice-home.test',
      machineId: 'alice-machine', token: 'alice-daemon-token',
      createExecutor: () => createActionExecutor({
        // Artifact persistence and reverse socket delivery leave the process.
        approvalsCreate: async ({ request }) => {
          persisted = StoredApprovalRequestSchema.parse(request);
          return { artifactId: 'native-home-approval' };
        },
        clientActionExecute: async () => { delivered += 1; return { ok: true, result: { status: 'completed' } }; },
      }),
    });
    const result = await execute({ ...operation, actionId: 'account.home_continuation.invoke',
      input: { operation: 'refresh', commandId: 'current-ui:home' } }, { sessionId: 'bob-session', isCurrent: async () => true });
    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'native-home-approval' } });
    const stored = StoredApprovalRequestSchema.parse(persisted);
    expect(stored).toMatchObject({ actionId: 'account.home_continuation.invoke',
      actionArgs: { operation: 'refresh', commandId: 'current-ui:home' },
      executionOriginV1: { authority: 'account_automation', machineId: 'alice-machine',
        caller: operation.witness.agentStartCaller } });
    if (stored.v !== 2) throw new Error('Native approval must retain current execution origin');
    expect(stored.executionOriginV1.externalActionExecutionAuthorization).toBeUndefined();
    expect(requiresExactDaemonApprovalReplay(stored)).toBe(true);
    expect(delivered).toBe(0);
  });
  it('selects the reviewed managed controller before minting rather than the originating Session Machine', () => {
    const controller = { machineId: 'remote-controller', installationId: 'remote-installation' };
    const common = { homeId: 'srv_source', controller, contribution: { pluginId: 'acme.compute', localId: 'vm' } };
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.provisioners.check', rawInput: common,
      fallbackMachineId: 'source-machine' })).toEqual({ kind: 'ready', machineId: controller.machineId });
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.managed.acquire', rawInput: { selection: {
      kind: 'one-off', homeId: common.homeId, controller,
      launch: { provider: common.contribution, schemaVersion: 1, name: 'guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    } }, fallbackMachineId: 'source-machine' })).toEqual({ kind: 'ready', machineId: controller.machineId });
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.provisioners.check', rawInput: common,
      target: { kind: 'machine', machineId: 'source-machine' } })).toMatchObject({ kind: 'rejected',
      execution: { errorCode: 'target_not_local' } });
  });

  it.each([
    ['agent', 'machines.provisioners.check', 'local'], ['mcp', 'machines.provisioners.check', 'local'],
    ['agent', 'machines.managed.inspect', 'local'], ['mcp', 'machines.managed.inspect', 'local'],
    ['agent', 'machines.provisioners.check', 'rpc'], ['agent', 'machines.managed.inspect', 'rpc'],
    ['agent', 'machines.managed.acquire', 'rpc'],
    ['agent', 'machines.managed.acquire', 'foreign-custodian-rpc'],
    ['agent', 'machines.provisioners.check', 'foreign-custodian-rpc'], ['agent', 'machines.managed.inspect', 'foreign-custodian-rpc'],
  ] as const)('executes %s %s through the original Home and current native owner over %s', async (surface, actionId, delivery) => {
    const serverHttpBaseUrl = 'https://managed-source.test';
    const homeId = 'srv_source';
    const source = { machineId: 'source-machine', installationId: 'source-installation' };
    const controller = delivery !== 'local' ? { machineId: 'remote-controller', installationId: 'receiver-installation' } : source;
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'source-account', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const sourceKeys = delivery !== 'local' ? nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32)) : keys;
    const custodianAccountId = delivery === 'foreign-custodian-rpc' ? 'custodian-account' : 'source-account';
    const receiverCredentials = delivery === 'foreign-custodian-rpc'
      ? { token: `fixture.${Buffer.from(JSON.stringify({ sub: custodianAccountId, tokenEpoch: 0,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null } : credentials;
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
      [configuration.activeServerId]: { id: configuration.activeServerId, name: 'Source Home', serverUrl: serverHttpBaseUrl,
        webappUrl: serverHttpBaseUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId,
          canonicalServerUrl: serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: serverHttpBaseUrl }] } },
    } }));
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    if (delivery === 'foreign-custodian-rpc' && actionId === 'machines.managed.acquire') {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: {
        v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.managed.acquire': ['agent'] },
      } }), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(receiverCredentials) });
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } },
    })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const native = nativeFixture({ privateNative: true });
    let machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId, custodianAccountId, controller,
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
      resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
      allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const input = ManagedMachineActionInputSchemasV1[actionId].parse(actionId === 'machines.provisioners.check'
      ? { homeId, controller, contribution: machine.launch.provider }
      : actionId === 'machines.managed.acquire' ? { selection: { kind: 'one-off', homeId, controller,
        launch: machine.launch, retention: machine.retention, wakeOnAcceptedMessage: false } } : { homeId, managedId: machine.id });
    const target = { kind: 'machine' as const, machineId: controller.machineId };
    const proofRequests: unknown[] = [];
    const paths: string[] = [];
    let storedApproval: Readonly<{ id: string; dataEncryptionKey: string; request: ReturnType<typeof StoredApprovalRequestSchema.parse> }> | undefined;
    // Only Home HTTP is substituted. The source owner, original proof signer,
    // shared Action policy, registry, custody and native invocation remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (storedApproval && path === `/v1/artifacts/${storedApproval.id}`) {
        const original = storedApproval.request;
        const rejected = StoredApprovalRequestSchema.parse({ ...original, status: 'rejected', updatedAtMs: original.updatedAtMs + 1,
          decision: { kind: 'reject', decidedAtMs: original.updatedAtMs + 1 } });
        return { status: 200, data: { id: storedApproval.id, dataEncryptionKey: storedApproval.dataEncryptionKey,
          ownerAccountId: 'source-account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
          headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: original.createdAtMs, updatedAt: rejected.updatedAtMs,
          header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(rejected, { legacyServerId: configuration.activeServerId })),
          body: encodePlainArtifactStoredContent({ body: JSON.stringify(rejected) }) } };
      }
      return String(url).endsWith('/v2/account/settings') ? { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } }
        : { status: 200, data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path.endsWith('/execution-authorization')) {
        expect(config?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
        const request = ExternalActionRequestEnvelopeV1Schema.parse(Reflect.get(body, 'envelope'));
        proofRequests.push(body);
        return { status: 200, data: { v: 1, token: 'source-home-proof', binding: {
          accountId: 'source-account', custodianAccountId, authentication: { kind: 'account', tokenEpoch: 0 },
          serverIdentityId: homeId, ...controller, installationId: controller.installationId,
          actionId, requestId: operation.requestId, target, accountEncryptionMode: 'plain',
          sessionActionOrigin: Reflect.get(body, 'sessionActionOrigin'), sessionActionSource: source,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request),
        } } };
      }
      if (path.endsWith('/verify')) {
        const signature = config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
        expect(typeof signature).toBe('string');
        const signed = { authorizationToken: 'source-home-proof', effectActionId: actionId, target,
          installationId: controller.installationId, requestId: operation.requestId, method: 'POST', path, body,
          signature: String(signature) };
        expect(verifyExternalActionMachineRequestV1({ ...signed, publicKey: keys.publicKey })).toBe(true);
        if (delivery !== 'local') expect(verifyExternalActionMachineRequestV1({ ...signed, publicKey: sourceKeys.publicKey })).toBe(false);
        return { status: 200, data: { ok: true } };
      }
      if (path === '/v1/artifacts') {
        const content = decodePlainArtifactStoredContent(String(Reflect.get(body, 'body')));
        const request = StoredApprovalRequestSchema.parse(JSON.parse(String(content && typeof content === 'object' ? Reflect.get(content, 'body') : null)));
        storedApproval = { id: String(Reflect.get(body, 'id')), dataEncryptionKey: String(Reflect.get(body, 'dataEncryptionKey')), request };
        return { status: 200, data: { id: storedApproval.id, headerVersion: 1, bodyVersion: 1 } };
      }
      if (path.endsWith('/admit')) return { status: 200, data: { machine, replayed: true } };
      if (path.endsWith('/actions/get')) return { status: 200, data: machine };
      if (delivery !== 'local' && /\/(?:context|current|report)$/.test(path)) {
        expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'source-home-proof' });
      }
      if (path.endsWith('/context')) return { status: 200, data: { machine, requestId: operation.requestId } };
      if (path.endsWith('/report')) machine = ManagedMachineV1Schema.parse({ ...machine, observation: Reflect.get(body, 'observation') });
      if (path.endsWith('/current') || path.endsWith('/report')) return { status: 200, data: { machine } };
      throw new Error(`Unexpected family source path ${path}`);
    });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential materialization'); };
    const providerAuthority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
      purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
      }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const managedMachineAction = createDaemonManagedMachineActionAdapter({ credentials: receiverCredentials, machineId: controller.machineId,
      serverBaseUrl: serverHttpBaseUrl, serverId: configuration.activeServerId,
      installationIdentity: { installationId: controller.installationId, privateKey: keys.secretKey },
      managedProviderOperationAuthority: providerAuthority,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: serverHttpBaseUrl, resolveCurrentMachineId: () => controller.machineId }),
      acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
    });
    const executor = createCliActionExecutorFromCredentials({ credentials: receiverCredentials, serverId: configuration.activeServerId,
      serverApiUrl: serverHttpBaseUrl, serverIdentityId: homeId, externalActionMachineRequestPrivateKey: keys.secretKey,
      externalActionMachineInstallationId: controller.installationId, managedMachineAction, pluginActionExecutionOwner: 'current_process' });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: configuration.activeServerId, serverHttpBaseUrl, token: credentials.token,
      prepareExternalActionAuthorization: async admission => {
        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId, input, requestId: operation.requestId,
          target, machineId: controller.machineId, sourceMachineId: source.machineId, accountId: 'source-account',
          accountEncryptionMode: 'plain', tokenEpochHint: 0, token: credentials.token,
          serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl,
          installationId: source.installationId, privateKey: sourceKeys.secretKey, sessionActionOrigin: admission.sessionActionOrigin,
          isCurrent: admission.isCallerCurrent, signal: admission.authority.signal });
        return authorization ? { authorization, target } : null;
      }, createExecutor: () => delivery === 'local' ? executor : { execute: async (_id, actionInput, context) => {
        const rpc = new RpcHandlerManager({ scopePrefix: controller.machineId, localMachineId: controller.machineId,
          encryptionMode: 'plain', logger: () => {}, authorizeRequest: async () => ({ ok: true }) });
        registerActionSpecRpcHandlers({ rpcHandlerManager: rpc,
          actionIds: [actionId], targetMachineId: controller.machineId, actionExecutor: executor,
          ...(actionId === 'machines.managed.acquire' ? { observeExecution: request =>
            createHostActionOperationRuntime({ machineId: controller.machineId, serverId: configuration.activeServerId,
              custodyBinding: { serverId: configuration.activeServerId, installationId: controller.installationId },
              resolveAccountId: async () => custodianAccountId })
              .observeExecution(request) } : {}) });
        // Private producer callbacks do not ride the existing socket wire.
        const authorization = context?.externalActionExecutionAuthorization;
        if (!authorization) throw new Error('Missing original source proof');
        const wireAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(authorization)));
        const result = await rpc.handleRequest({ method: `${controller.machineId}:${actionId}`,
          params: { v: 1, kind: 'targeted_action_rpc', target, input: actionInput },
          requestId: 'home-relay-correlation', callerAuthority: 'account_automation',
          sessionActionOrigin: authorization.binding.sessionActionOrigin,
          callerInputAuthorization: wireAuthorization,
          machineAdmission: { actorAccountId: 'source-account', custodianAccountId, ...controller,
            role: 'manage', encryptionMode: 'plain' },
        });
        return { ok: true, result };
      } },
    });
    const result = await execute({ ...operation, actionId, input, surface }, { sessionId: 'bob-session', isCurrent: async () => true });
    if (delivery === 'foreign-custodian-rpc' && actionId === 'machines.managed.acquire') {
      expect(result).toEqual({ ok: true, result: { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' } });
      expect(storedApproval).toBeUndefined();
      expect(native.effects()).toBe(0);
      expect(paths.some(path => /\/(?:admit|submit|enrollment-context)$/.test(path))).toBe(false);
      return;
    }
    if (actionId === 'machines.managed.acquire') {
      expect(result).toEqual({ ok: true, result: { ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' } });
      const approval = storedApproval?.request;
      if (!approval || approval.v !== 2 || !approval.executionOriginV1.externalActionInputSignature) throw new Error('Missing signed receiver approval');
      expect(approval.executionOriginV1).toMatchObject({ accountId: 'source-account', machineId: controller.machineId,
        caller: operation.witness.agentStartCaller, externalActionExecutionAuthorization: { binding: { sessionActionSource: source } } });
      const signed = { authorizationToken: 'source-home-proof', actionId, input: approval.actionArgs, target,
        signature: approval.executionOriginV1.externalActionInputSignature };
      expect(verifyExternalActionApprovalInputV1({ ...signed, publicKey: keys.publicKey })).toBe(true);
      expect(verifyExternalActionApprovalInputV1({ ...signed, publicKey: sourceKeys.publicKey })).toBe(false);
      expect(native.effects()).toBe(0);
      expect(paths.some(path => /\/(?:admit|submit|enrollment-context)$/.test(path))).toBe(false);
      return;
    }
    expect(result, JSON.stringify(result)).toEqual({ ok: true, result: ManagedMachineActionOutputSchemasV1[actionId].parse(
      actionId === 'machines.provisioners.check' ? { available: true } : { machine }) });
    expect(proofRequests).toEqual([expect.objectContaining({ sessionActionOrigin: expect.objectContaining({
      caller: operation.witness.agentStartCaller, sourceTurnId: operation.witness.turnId, requestId: operation.requestId,
    }), installationProof: expect.any(Object) })]);
    expect(native.effects()).toBe(1);
    expect(paths.some(path => /\/(?:admit|submit|enrollment-context)$/.test(path))).toBe(false);
    if (actionId === 'machines.managed.inspect') expect(machine.observation).toEqual({ observedAt: 0, availability: 'present' });
  });

  it('reaches the canonical handoff Action with its actual original Session witness and Home-issued root instead of upgrading to human authority', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const target = { kind: 'machine' as const, machineId: 'source-machine' };
    const handoff: Operation = { ...operation, actionId: 'session.handoff',
      input: { sessionId: 'bob-session', targetMachineId: 'target-machine', targetPath: '/target' } };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    const network = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(request.envelope.handoffAdmission).toEqual({ sessionId: 'bob-session',
        sourceMachineId: 'source-machine', targetMachineId: 'target-machine' });
      return { status: 200, data: { v: 1, token: 'home-issued-handoff-root', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_home',
        machineId: target.machineId, custodianAccountId: 'alice', installationId: 'source-installation',
        actionId: handoff.actionId, requestId: handoff.requestId, target, accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin,
        sessionActionSource: { machineId: target.machineId, installationId: 'source-installation' },
        handoffAdmission: { sessionId: 'bob-session', sourceMachineId: target.machineId, targetMachineId: 'target-machine',
          sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
      } } };
    });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'bob-profile',
      serverHttpBaseUrl: 'https://bob-home.test', token: 'bob-session-token',
      prepareExternalActionAuthorization: async ({ sessionActionOrigin }) => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: handoff.requestId,
          target, input: handoff.input, handoffAdmission: { sessionId: 'bob-session', sourceMachineId: target.machineId,
            targetMachineId: 'target-machine' } });
        const minted = await mintExternalActionExecutionAuthorization({ actionId: handoff.actionId, envelope,
          machineId: target.machineId, pat: 'bob-session-token', serverHttpBaseUrl: 'https://bob-home.test',
          sessionActionOrigin, sessionActionSource: { machineId: target.machineId, installationId: 'source-installation' },
          installationProof: signMachineInstallationProof({ privateKey: keys.secretKey, payload: {
            version: 1, accountId: 'bob', machineId: target.machineId, installationId: 'source-installation',
            externalActionOrigin: { homeId: 'srv_home', actionId: handoff.actionId, requestId: handoff.requestId,
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: sessionActionOrigin },
          } }) });
        return minted.ok ? { authorization: minted.authorization, target } : null;
      },
      createExecutor: () => createActionExecutor({
        ...createCliActionDeps({ token: 'bob-session-token', sessionId: '', mode: 'plain', ctx: null }),
        // Machine RPC delivery is the genuine effect boundary.
        sessionHandoffStart: async () => ({ ok: false, errorCode: 'handoff_owner_reached', error: 'handoff_owner_reached' }),
      }),
    });
    expect(await execute(handoff, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'handoff_owner_reached' });
    expect(network).toHaveBeenCalled();
  });

  it('refuses the originating Account creation preference before minting its managed Action proof', async () => {
    const serverHttpBaseUrl = 'https://source-home.test';
    const token = 'source-account-token';
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ managedMachineCreationEnabled: false }),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(token)) });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    const network = vi.spyOn(axios, 'post');
    const admitted: string[] = [];
    const acquire: Operation = { ...operation, actionId: 'machines.managed.acquire', input: { selection: {
      kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'source-machine', installationId: 'installation' },
      launch: { provider: { pluginId: 'compute.example', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    } } };
    const target = { kind: 'machine' as const, machineId: 'source-machine' };
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'source-profile', serverHttpBaseUrl, token,
      prepareExternalActionAuthorization: async () => {
        const minted = await mintExternalActionExecutionAuthorization({ actionId: acquire.actionId, machineId: target.machineId,
          envelope: ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: acquire.requestId, target, input: acquire.input }),
          pat: token, serverHttpBaseUrl });
        return minted.ok ? { authorization: minted.authorization, target } : null;
      },
      createExecutor: () => createActionExecutor({ ...createCliActionDeps({ token, sessionId: '', mode: 'plain', ctx: null }),
        // Durable acquisition is the effect boundary, not an admission mock.
        managedMachineAction: async ({ actionId }) => { admitted.push(actionId); return { managedId: 'managed' }; },
      }),
    });
    expect(await execute(acquire, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toEqual({ ok: false, errorCode: 'creation_disabled', error: 'creation_disabled' });
    expect(network).not.toHaveBeenCalled();
    expect(admitted).toEqual([]);
  });

  it('carries original requester Home authorization from the admitted Session into Account effects', async () => {
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const target = { kind: 'machine' as const, machineId: 'alice-machine' };
    const envelope = { v: 1 as const, requestId: operation.requestId, target, input: operation.input };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, _body, config) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      expect(config?.headers).toMatchObject({ Authorization: 'Bearer bob-session-token' });
      return { status: 200, data: { v: 1, token: 'bob-home-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 4 }, serverIdentityId: 'bob-home',
        machineId: target.machineId, custodianAccountId: 'alice', installationId: 'alice-installation',
        actionId: operation.actionId, requestId: operation.requestId, target, accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
    });
    let delivered = 0;
    const execute = createDaemonSessionAccountActionExecutor({
      serverId: 'bob-profile', serverHttpBaseUrl: 'https://bob-home.test', token: 'bob-session-token',
      ...{ prepareExternalActionAuthorization: async () => {
        const minted = await mintExternalActionExecutionAuthorization({ actionId: operation.actionId, envelope,
          machineId: target.machineId, pat: 'bob-session-token', serverHttpBaseUrl: 'https://bob-home.test' });
        if (!minted.ok) return null;
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: minted.authorization,
          serverId: 'bob-profile', serverIdentityId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test',
          target, installationId: 'alice-installation', privateKey: installation.secretKey });
        return authorization ? { authorization, target } : null;
      } },
      createExecutor: () => createActionExecutor({
        ...createCliActionDeps({ token: 'bob-session-token', sessionId: '', mode: 'plain', ctx: null }),
        notificationsNotifyMe: async (_input, context) => {
          const headers = await context.externalActionExecutionAuthorization?.requesterHttpProjection?.createRequestHeaders({
            effectActionId: operation.actionId, method: 'POST', path: '/v1/projects/account-rows/list', body: {},
          });
          if (headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'bob-home-proof') delivered += 1;
          return { attemptedChannels: 1, deliveredChannels: delivered };
        },
      }),
    });
    expect(await execute(operation, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    expect(delivered).toBe(1);
    expect(network).toHaveBeenCalled();
  });

  it.each(['recipient', 'missing'] as const)('refuses a %s Session before using the daemon Account', async (kind) => {
    vi.spyOn(axios, 'get').mockResolvedValue(kind === 'missing'
      ? { status: 404, data: {} }
      : { status: 200, data: { session: createSessionRecordFixture({ id: 'bob-session',
          share: { accessLevel: 'admin', canApprovePermissions: true } }) } });
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: {
        reason: kind === 'missing' ? 'session_owner_missing' : 'session_not_owner',
      } });
    expect(harness.delivered).toEqual([]);
  });

  it('diagnoses a refused client Action proof without disclosing its input or credentials', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    // File logging and authenticated Home reads are genuine system boundaries.
    const logged = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 403, data: {} });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'alice-home',
      serverHttpBaseUrl: 'https://alice-home.test', token: 'private-daemon-token',
      prepareExternalActionAuthorization: async ({ operation: action, sessionActionOrigin }) => {
        const target = { kind: 'machine' as const, machineId: 'source-machine' };
        const minted = await mintExternalActionExecutionAuthorization({ actionId: action.actionId,
          envelope: ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: action.requestId, target, input: action.input }),
          machineId: target.machineId, pat: 'private-daemon-token', serverHttpBaseUrl: 'https://alice-home.test', sessionActionOrigin });
        return minted.ok ? { authorization: minted.authorization, target } : null;
      },
      createExecutor: () => createActionExecutor(createCliActionDeps({ token: 'private-daemon-token', sessionId: '', mode: 'plain', ctx: null })),
    });
    const search: Operation = { ...operation, actionId: 'search.conversations', input: {
      query: { v: 1, query: 'private-query', scope: { type: 'global' }, mode: 'hints' },
      machineIds: ['source-machine'], mode: 'indexed',
    } };
    expect(await execute(search, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'external_authorization_refused' } });
    expect(logged.mock.calls).toEqual([[expect.any(String), {
      actionId: search.actionId, sessionId: 'bob-session', requestId: search.requestId,
      turnId: operation.witness.turnId, reason: 'external_authorization_refused',
    }]]);
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private-query|private-daemon-token/);
    expect(network).toHaveBeenCalled();
  });

  it('preserves owner execution and rechecks the exact Home owner after admission changes', async () => {
    const read = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    expect(harness.delivered).toHaveLength(1);
    expect(read).toHaveBeenCalledWith('https://alice-home.test/v2/sessions/bob-session',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer alice-daemon-token' }) }));
    read.mockResolvedValue({ status: 404, data: {} });
    expect(await harness.isCallerCurrent()).toBe(false);
  });

  it('refuses retired runtime custody before reading the Account or delivering', async () => {
    const read = vi.spyOn(axios, 'get');
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => false }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'runtime_authority_unavailable' } });
    expect(read).not.toHaveBeenCalled();
    expect(harness.delivered).toEqual([]);
  });

  it('refuses custody retired while the authenticated owner read is pending', async () => {
    let live = true;
    vi.spyOn(axios, 'get').mockImplementation(async () => {
      live = false;
      return { status: 200, data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } };
    });
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => live }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'runtime_authority_unavailable' } });
    expect(harness.delivered).toEqual([]);
  });

  it('preserves target_unavailable when cancellation arrives during the initial custody check', async () => {
    const controller = new AbortController();
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', signal: controller.signal,
      isCurrent: async () => { controller.abort(); return false; } }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'runtime_authority_unavailable' } });
    expect(harness.delivered).toEqual([]);
  });
});
