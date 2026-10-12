import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ActionExecuteResult, ActionId } from '@happier-dev/protocol/actions';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ApprovalRequestV2Schema, requiresExactDaemonApprovalReplay } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ExternalActionExecutionResultV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectAccountRowMutationRequestV1Schema, buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ProjectSourcesCreateInputV1Schema, ProjectSourcesUpdateInputV1Schema, ProjectSourcesDeleteInputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ApiMachineClient } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { ApiClient } from '@/api/api';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createSocketIoManagerStub } from '@/testkit/backends/apiSessionSocketHarness';
import { configuration, reloadConfiguration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { updateSettings, writeStoredCredentialsForServerId } from '@/persistence';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { verifyExternalActionExecutionAuthorizationCurrent, resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { executeExternalAction } from './executeExternalAction';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';

const socketBoundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('socket.io-client', async importOriginal => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return { ...actual, io: (...args: Parameters<typeof actual.io>) => socketBoundary.create(...args) };
});
afterEach(() => { vi.restoreAllMocks(); socketBoundary.create.mockReset(); withdrawActiveProjectAccountRowsSnapshot(); });
const filesystemIds = ['daemon.filesystem.readFile', 'daemon.filesystem.writeFile', 'daemon.filesystem.listDirectory',
  'daemon.filesystem.getDirectoryTree', 'daemon.filesystem.createDirectory', 'daemon.filesystem.rename', 'daemon.filesystem.delete'] as const;
const bytes = Buffer.from([0, 255, 128, 10]);
const repository = { provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git' }, protocol: 'https' as const };

// Extend the incumbent continuation harness. Production composition/registrars,
// policy, custody, codecs and effects remain real; Home transport and durable
// approval persistence are the only substituted system boundaries.
async function createHarness(actionId: ActionId, approval: 'ask' | 'allowed' = 'ask') {
  const directory = await mkdtemp(join(tmpdir(), 'happier-action-composition-'));
  const rootPath = join(directory, 'accepted');
  await mkdir(rootPath); await writeFile(join(rootPath, 'original'), bytes);
  await writeFile(join(directory, 'outside'), 'outside unchanged');
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_MACHINE_RPC_WORKING_DIRECTORY']);
  env.patch({ HAPPIER_HOME_DIR: join(directory, 'srv_n2'), HAPPIER_ACTIVE_SERVER_ID: 'srv_n2',
    HAPPIER_SERVER_URL: 'https://home.example.test', HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: directory });
  reloadConfiguration();
  expect(configuration.activeServerId).toBe('srv_n2');
  const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url') + '.signature';
  const credentials = { token, encryption: null };
  await updateSettings(settings => ({ ...settings, activeServerId: 'srv_n2', servers: { srv_n2: { id: 'srv_n2', name: 'Home',
    serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 } } }));
  await writeStoredCredentialsForServerId('srv_n2', credentials);
  const installation = await readOrCreateInstallationIdentity();
  const privateKey = Buffer.from(installation.privateKey, 'base64url');
  const publicKey = Buffer.from(installation.publicKey, 'base64url');
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const ref = { id: 'workspace', serverId: 'srv_n2', machineId: target.machineId, rootPath, projectKey: 'project', createdAtMs: 1 };
  const refKey = { kind: 'workspace-ref' as const, serverId: 'srv_n2', id: ref.id };
  const organizationKey = { kind: 'project-organization' as const, serverId: 'srv_n2', projectKey: 'project' };
  const rows: ProjectAccountRowV1[] = [
    { key: refKey, revision: 2, content: { t: 'plain', v: { key: refKey, value: ref } } },
    { key: organizationKey, revision: 2, content: { t: 'plain', v: { key: organizationKey, value: { hidden: false, pinned: false,
      promptStack: [{ id: 'context-entry', enabled: true, placement: 'system_append', ref: { kind: 'doc', artifactId: 'context-doc' } }] } } } },
  ];
  const accountSettings = { actionsSettingsV1: { v: 1, actions: approval === 'ask'
    ? { [actionId]: { approvalRequiredSurfaces: ['ui', 'rpc', 'cli'] } } : {},
    ...(approval === 'allowed' ? { approvalWaivedSurfaces: { [actionId]: ['ui', 'rpc', 'cli'] } } : {}) } };
  let artifact: Readonly<Record<string, unknown>> | undefined;
  let source: ProjectSourceV1 | null = { id: 'source', revision: 2, name: 'App', repository, audience: [], createdByAccountId: 'account' };
  const networkPaths: string[] = [];
  const rpcOutcomes: unknown[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    networkPaths.push('GET ' + path);
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'account' } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: accountSettings }, version: 1 } };
    if (path === '/v1/artifacts') return { status: 200, data: artifact ? [artifact] : [] };
    if (artifact && path === '/v1/artifacts/' + artifact.id) return { status: 200, data: artifact };
    if (path === '/v1/account/authoring-memory') return { status: 200, data: { rows: [] } };
    if (path === '/v1/machines/machine') return { status: 200, data: { machine: { id: 'machine', storageMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      installationId: installation.installationId, installationPublicKey: publicKey.toString('base64'),
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } } };
    if (path === '/v1/machines') return { status: 200, data: [{ id: 'machine', active: true, kind: 'persistent',
      installationId: installation.installationId, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null }] };
    throw new Error('Unexpected Home GET ' + path);
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    networkPaths.push('FETCH ' + path);
    if (path !== '/v1/features' && path !== '/v1/features/authenticated') throw new Error('Unexpected Home fetch ' + path);
    return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_n2' } } });
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    networkPaths.push('POST ' + path);
    if (path === '/v1/artifacts') {
      const input = readCarrierMutation(body);
      artifact = { ...input, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
    }
    if (artifact && path === '/v1/artifacts/' + artifact.id) {
      const input = readCarrierMutation(body);
      if (input.expectedHeaderVersion !== artifact.headerVersion || input.expectedBodyVersion !== artifact.bodyVersion) {
        return { status: 409, data: { success: false, error: 'version-mismatch' } };
      }
      const headerVersion = Number(artifact.headerVersion) + 1; const bodyVersion = Number(artifact.bodyVersion) + 1;
      artifact = { ...artifact, ...input, headerVersion, bodyVersion };
      return { status: 200, data: { success: true, headerVersion, bodyVersion } };
    }
    if (path.includes('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
    if (path.endsWith('/verify')) return { status: 200, data: { v: 1, ok: true } };
    if (path === '/v1/account/project-rows/list') return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
    if (path === '/v1/account/project-rows/mutate') {
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changes: ProjectAccountRowV1[] = [];
      for (const mutation of request.mutations) {
        const prior = rows.find(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(mutation.key));
        if (mutation.expectedRevision !== (prior?.revision ?? 'absent')) return { status: 409, data: { status: 'conflict',
          key: mutation.key, revision: prior?.revision ?? -1 } };
        changes.push({ key: mutation.key, revision: (prior?.revision ?? -1) + 1, content: mutation.content });
      }
      for (const row of changes) {
        const index = rows.findIndex(prior => buildProjectAccountRowPhysicalKeyV1(prior.key) === buildProjectAccountRowPhysicalKeyV1(row.key));
        if (index < 0) rows.push(row); else rows[index] = row;
      }
      return { status: 200, data: { status: 'updated', rows: changes, cursor: 3 } };
    }
    throw new Error('Unexpected Home POST ' + path);
  });
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    const path = new URL(String(request.url)).pathname;
    networkPaths.push(String(request.method) + ' ' + path);
    if (path === '/v1/auth/api-tokens/list') return { status: 200, data: { tokens: [] } };
    if (path === '/v1/projects/sources') {
      if (request.method === 'GET') return { status: 200, data: { ok: true, sources: source ? [source] : [], coverage: { complete: true, nextCursor: null } } };
      const input = ProjectSourcesCreateInputV1Schema.parse(request.data);
      source = { id: 'created-source', revision: 1, name: input.name, repository: input.repository, audience: input.audience ?? [], createdByAccountId: 'account' };
      return { status: 201, data: { ok: true, source, canManage: true } };
    }
    if (path === '/v1/projects/sources/source' && source) {
      if (request.method === 'GET') return { status: 200, data: { ok: true, source, canManage: true } };
      if (request.method === 'PATCH') {
        const input = ProjectSourcesUpdateInputV1Schema.parse(request.data);
        if (input.expectedRevision !== source.revision) return { status: 409, data: { ok: false, error: 'source_conflict', current: source } };
        source = { ...source, name: input.patch.name ?? source.name, revision: source.revision + 1 };
        return { status: 200, data: { ok: true, source, canManage: true } };
      }
      const input = ProjectSourcesDeleteInputV1Schema.parse(request.data);
      expect(input.expectedRevision).toBe(source.revision);
      const revision = source.revision + 1; source = null;
      return { status: 200, data: { ok: true, sourceId: 'source', revision } };
    }
    throw new Error('Unexpected Home request ' + path);
  });
  const client = new ApiMachineClient(token, { id: target.machineId, encryptionMode: 'plain', metadata: null,
    metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
  const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing production RPC manager');
  const rpc = manager;
  const admission = { actorAccountId: 'account', custodianAccountId: 'account', machineId: target.machineId,
    installationId: installation.installationId, role: 'manage' as const, encryptionMode: 'plain' as const };
  socketBoundary.create.mockImplementation(() => {
    const events = new EventEmitter();
    const socket = Object.assign(events, { io: createSocketIoManagerStub(), connected: false,
      connect: () => { socket.connected = true; events.emit('connect'); return socket; },
      disconnect: () => { socket.connected = false; return socket; }, close: () => socket,
      emitWithAck: async (_event: string, packet: Readonly<{ method: string; params: unknown; requestId?: string;
        originalActionEnvelope?: Parameters<typeof executeExternalAction>[0]['envelope'];
        externalActionExecution?: Readonly<{ authorization: NonNullable<import('@happier-dev/protocol/actions').ActionExecutorContext['externalActionExecutionAuthorization']>;
          machineSignature: string; effectActionId: string; target: typeof target; installationId: string }> }>) => {
        const execution = packet.externalActionExecution;
        if (execution?.authorization.requesterAccountContext) {
          const opensFor = (method: string) => openExternalActionRequesterAccountContextV1({ authorization: execution.authorization,
            purpose: { kind: 'machine_rpc', method, params: packet.params }, machineId: target.machineId,
            installationId: installation.installationId, serverIdentityId: 'srv_n2', installationPrivateKey: privateKey }) !== null;
          // Safe custody discriminator: never retain or print opened credentials.
          rpcOutcomes.push({ custodyOpensForUnscopedMethod: opensFor(packet.method.slice(target.machineId.length + 1)),
            custodyOpensForScopedMethod: opensFor(packet.method) });
        }
        if (execution) expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
          effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
          event: SOCKET_RPC_EVENTS.CALL, method: packet.method, requestId: packet.requestId!, params: packet.params,
          signature: execution.machineSignature, publicKey })).toBe(true);
        const result = await rpc.handleRequest({ method: packet.method, params: packet.params,
          ...(packet.requestId ? { requestId: packet.requestId } : {}),
          callerAuthority: execution ? resolveExternalActionRootInvocationAuthority(execution.authorization) : 'present_user',
          machineAdmission: admission,
          ...(packet.originalActionEnvelope ? { originalActionEnvelope: packet.originalActionEnvelope } : {}),
          ...(execution ? { callerInputAuthorization: execution.authorization } : {}) });
        rpcOutcomes.push(result);
        return { ok: true, result };
      } });
    return socket;
  });
  const resolveTarget = createDaemonExternalActionTargetResolver({ credentials });
  const settings = createActionSettingsProvider({ accountSettings: accountSettingsParse(accountSettings) });
  const params = { token, credentials, sessionId: '', mode: 'plain' as const, ctx: null, serverId: 'srv_n2', serverIdentityId: 'srv_n2',
    serverHttpBaseUrl: 'https://home.example.test', actionsSettingsProvider: settings,
    externalActionMachineInstallationId: installation.installationId, externalActionMachineRequestPrivateKey: privateKey };
  const resolveOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: params.serverHttpBaseUrl,
    resolveCurrentMachineId: () => target.machineId });
  const verifyRoot: NonNullable<Parameters<typeof executeExternalAction>[0]['verifyExecutionAuthorization']> = input =>
    verifyExternalActionExecutionAuthorizationCurrent({ ...input, privateKey, installationId: installation.installationId,
      serverHttpBaseUrl: params.serverHttpBaseUrl });
  const originCurrent = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'account', machineId: target.machineId, serverId: 'srv_n2',
    resolveCurrentMachineExecutionOriginContext: resolveOrigin, resolveTarget, listAccountApiTokens: async () => ({ tokens: [] }),
    externalActionMachinePublicKey: publicKey, verifyExternalExecutionAuthorization: verifyRoot });
  const runtime = await startDaemonSessionControlRuntime({ machineId: target.machineId, credentials,
    serverId: 'srv_n2', serverBaseUrl: params.serverHttpBaseUrl, externalActionAccountId: 'account',
    api: await ApiClient.create(credentials), connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
    daemonSessionMutationCustody: { stageTranscriptEvent: async () => { throw new Error('Unexpected Session event'); },
      stageTranscriptMessage: async () => { throw new Error('Unexpected Session message'); } },
    getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
    pidToTrackedSession: new Map(), pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
    getApiMachineForSessions: () => client, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
    connectedServicesRestartRequestedPids: new Set(), resolveCurrentMachineExecutionOriginContext: resolveOrigin,
    beforeShutdown: async () => {}, onHappySessionWebhook: async () => { throw new Error('Open must never start an Agent'); },
    requestShutdown() {}, processEnv: {} });
  const installed = runtime.externalActionIngressOwner;
  if (!installed) throw new Error('Production external Action owner was not installed');
  const owner = installed.executor;
  const prepareRequester = installed.prepareRequesterAccountContext;
  client.setRPCHandlers({ spawnSession: async () => { throw new Error('Open must never start an Agent'); },
    stopSession: async () => true, requestShutdown() {} }, { actionsSettingsProvider: settings,
    externalActionIngressOwner: installed });
  const store = createCliApprovalsArtifactStore({ credentials, serverId: 'srv_n2' });
  const deciding = createCliActionExecutorHarness(params, { isApprovalExecutionOriginCurrent: originCurrent,
    approvalRequestApprovedReplay: async ({ artifactId }) => ExternalActionExecutionResultV1Schema.parse(
      await rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId })) }).executor;
  const artifactId = () => { if (!artifact) throw new Error('Missing approval Artifact'); return String(artifact.id); };
  return { rootPath, directory, ref, rows, rpcOutcomes, networkPaths, source: () => source, hasApproval: () => artifact !== undefined,
    approval: async () => ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: artifactId() })),
    decide: (decision: 'approve' | 'reject' | 'cancel', authority: 'present_user' | 'account_automation' = 'present_user') =>
      deciding.execute('approval.request.decide', { artifactId: artifactId(), decision }, { surface: 'ui', authority }),
    replay: () => rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId: artifactId() }),
    async run(input: unknown, surface: 'ui' | 'cli'): Promise<ActionExecuteResult> {
      const authentication = { kind: surface === 'cli' ? 'terminal' as const : 'account' as const, tokenEpoch: 1 };
      const envelope = { v: 1 as const, requestId: 'original-request', target, input };
      const authorization = { v: 1 as const, token: 'synthetic-home-root', binding: { accountId: 'account', custodianAccountId: 'account',
        authentication, accountEncryptionMode: 'plain' as const, serverIdentityId: 'srv_n2', machineId: target.machineId,
        installationId: installation.installationId, actionId, requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } };
      expect(ExternalActionExecutionAuthorizationV1Schema.safeParse(authorization).success).toBe(true);
      expect(ExternalActionRequestEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect(await resolveOrigin()).toEqual({ serverIdentityId: 'srv_n2', machineId: target.machineId });
      const result = await executeExternalAction({ actionId, envelope, principal: { accountId: 'account', authority: 'account_automation', authentication },
        surface, executionAuthorization: authorization, currentMachineId: target.machineId, currentServerId: 'srv_n2',
        currentServerHttpBaseUrl: params.serverHttpBaseUrl, currentInstallationId: installation.installationId,
        externalActionMachineRequestPrivateKey: privateKey, verifyExecutionAuthorization: verifyRoot,
        resolveTarget, executor: owner, prepareRequesterAccountContext: prepareRequester });
      expect(result.kind, JSON.stringify({ result, networkPaths })).toBe('response');
      if (result.kind !== 'response') throw new Error('External Action ingress refused');
      return result.response.execution;
    },
    raw: (input: unknown, requestId: string | null = 'original-request') => rpc.handleRequest({ method: target.machineId + ':' + actionId,
      params: input, ...(requestId ? { requestId } : {}), callerAuthority: 'present_user', machineAdmission: admission }),
    async close() { await runtime.stopControlServer(); await client.shutdown(); env.restore(); reloadConfiguration(); await rm(directory, { recursive: true, force: true }); },
  };
}

describe('Machine filesystem approval continuity from UI and paired terminal', () => {
  it.each(filesystemIds.flatMap(actionId => (['ui', 'cli'] as const).flatMap(surface =>
    (['approve', 'reject'] as const).map(decision => ({ actionId, surface, decision })))))
  ('retains exact $actionId from $surface through $decision using production composition', async ({ actionId, surface, decision }) => {
    const h = await createHarness(actionId);
    const input = actionId === 'daemon.filesystem.rename' ? { rootPath: h.rootPath, from: 'original', to: 'renamed', overwrite: false }
      : actionId === 'daemon.filesystem.delete' ? { rootPath: h.rootPath, path: 'original', recursive: false }
      : actionId === 'daemon.filesystem.writeFile' ? { rootPath: h.rootPath, path: 'binary', content: bytes.toString('base64'), expectedHash: null }
      : actionId === 'daemon.filesystem.readFile' ? { rootPath: h.rootPath, path: 'original' }
      : actionId === 'daemon.filesystem.createDirectory' ? { rootPath: h.rootPath, path: 'folder' }
      : { rootPath: h.rootPath, path: '.', ...(actionId === 'daemon.filesystem.getDirectoryTree' ? { maxDepth: 1 } : {}) };
    try {
      expect(await h.run(input, surface)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId } });
      expect(await h.approval()).toMatchObject({ status: 'open', actionArgs: input, executionOriginV1: { requestId: 'original-request',
        surface, authority: 'account_automation', accountId: 'account', externalActionInputSignature: expect.any(String) } });
      expect(await readdir(h.rootPath)).toEqual(['original']);
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      const decided = await h.decide(decision);
      expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: decision === 'reject' ? 'rejected' : 'executed' } });
      if (decision === 'reject') {
        expect(await h.replay()).toMatchObject({ ok: false, errorCode: 'approval_not_approved' });
        expect(await readdir(h.rootPath)).toEqual(['original']);
        expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      } else {
        const result = (await h.approval()).execution?.result;
        if (actionId === 'daemon.filesystem.readFile') expect(result).toEqual({ success: true, content: bytes.toString('base64') });
        else if (actionId === 'daemon.filesystem.listDirectory') expect(result).toMatchObject({ success: true,
          entries: [expect.objectContaining({ name: 'original', type: 'file' })] });
        else if (actionId === 'daemon.filesystem.getDirectoryTree') expect(result).toMatchObject({ success: true,
          tree: { children: [expect.objectContaining({ name: 'original' })] } });
        else if (actionId === 'daemon.filesystem.delete') expect(await readdir(h.rootPath)).toEqual([]);
        else if (actionId === 'daemon.filesystem.createDirectory') expect((await stat(join(h.rootPath, 'folder'))).isDirectory()).toBe(true);
        else expect(await readFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'))).toEqual(bytes);
        if (actionId === 'daemon.filesystem.writeFile') expect(result).toMatchObject({ hash: createHash('sha256').update(bytes).digest('hex') });
        // An intervening edit distinguishes repeated effects from durable observation.
        const keptPath = join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed'
          : actionId === 'daemon.filesystem.delete' || actionId === 'daemon.filesystem.readFile' ? 'original' : 'binary');
        await writeFile(keptPath, 'subsequent user edit');
        if (actionId === 'daemon.filesystem.createDirectory') await rm(join(h.rootPath, 'folder'), { recursive: true });
        expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(await readFile(keptPath, 'utf8')).toBe('subsequent user edit');
        expect((await h.approval()).execution?.result).toEqual(result);
        if (actionId === 'daemon.filesystem.createDirectory') await expect(stat(join(h.rootPath, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(join(h.directory, 'outside'), 'utf8')).toBe('outside unchanged');
    } finally { await h.close(); }
  });

  it.each((['daemon.filesystem.writeFile', 'daemon.filesystem.createDirectory', 'daemon.filesystem.rename', 'daemon.filesystem.delete'] as const)
    .flatMap(actionId => (['approve', 'reject', 'cancel'] as const).map(decision => ({ actionId, decision }))))
  ('retains the raw no-signal UI $actionId request id through $decision', async ({ actionId, decision }) => {
    const h = await createHarness(actionId);
    const input = actionId === 'daemon.filesystem.writeFile' ? { rootPath: h.rootPath, path: 'binary', content: bytes.toString('base64'), expectedHash: null }
      : actionId === 'daemon.filesystem.createDirectory' ? { rootPath: h.rootPath, path: 'folder' }
      : actionId === 'daemon.filesystem.rename' ? { rootPath: h.rootPath, from: 'original', to: 'renamed', overwrite: false }
      : { rootPath: h.rootPath, path: 'original', recursive: false };
    try {
      expect(await h.raw(input)).toMatchObject({ kind: 'approval_request_created' });
      expect(await h.approval()).toMatchObject({ status: 'open', executionOriginV1: { surface: 'rpc', requestId: 'original-request' } });
      expect(await h.decide('approve', 'account_automation')).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(await h.approval()).toMatchObject({ status: 'open' });
      expect(await readdir(h.rootPath)).toEqual(['original']);
      const decided = await h.decide(decision);
      expect(decided, JSON.stringify({ decided, networkPaths: h.networkPaths })).toMatchObject({ ok: true, result: { status: decision === 'approve' ? 'executed'
        : decision === 'reject' ? 'rejected' : 'canceled' } });
      if (decision !== 'approve') {
        expect(await h.replay()).toMatchObject({ ok: false, errorCode: 'approval_not_approved' });
        expect(await readdir(h.rootPath)).toEqual(['original']);
        expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
      } else {
        if (actionId === 'daemon.filesystem.delete') expect(await readdir(h.rootPath)).toEqual([]);
        else if (actionId === 'daemon.filesystem.createDirectory') expect((await stat(join(h.rootPath, 'folder'))).isDirectory()).toBe(true);
        else expect(await readFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'))).toEqual(bytes);
        await writeFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'), 'subsequent user edit');
        expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(await readFile(join(h.rootPath, actionId === 'daemon.filesystem.rename' ? 'renamed' : 'binary'), 'utf8')).toBe('subsequent user edit');
      }
    } finally { await h.close(); }
  });

  it.each((['ui', 'cli'] as const).flatMap(surface => (['ask', 'allowed'] as const).map(approval => ({ surface, approval }))))
  ('opens a real folder from $surface under $approval policy and retains its accepted row', async ({ surface, approval }) => {
    const h = await createHarness('projects.open', approval);
    const input = { serverId: 'srv_n2', machineId: 'machine', source: { kind: 'folder', path: h.rootPath }, materialization: { kind: 'attach' } };
    try {
      const initialRows = JSON.stringify(h.rows);
      const invocation = await h.run(input, surface);
      if (approval === 'ask') expect(JSON.stringify(h.rows)).toBe(initialRows);
      const result = approval === 'ask' ? await h.decide('approve') : invocation;
      if (approval === 'ask') expect(invocation).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      const opened = { kind: 'opened', directory: h.rootPath, workspace: { serverId: 'srv_n2', machineId: 'machine', rootPath: h.rootPath } };
      expect(result, JSON.stringify({ result, rpcOutcomes: h.rpcOutcomes })).toMatchObject(approval === 'ask'
        ? { ok: true, result: { status: 'executed', execution: { ok: true, result: opened } } } : { ok: true, result: opened });
      const accepted = JSON.stringify(h.rows);
      if (approval === 'ask') expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(JSON.stringify(h.rows)).toBe(accepted);
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
    } finally { await h.close(); }
  });

  it.each((['ui', 'cli'] as const).flatMap(surface => (['projects.list', 'projects.workspace.update', 'projects.workspace.forget',
    'projects.visibility.set', 'projects.context.update', 'projects.sources.list', 'projects.sources.read', 'projects.sources.create', 'projects.sources.update',
    'projects.sources.delete'] as const).flatMap(actionId => (['ask', 'allowed'] as const).map(approval => ({ actionId, surface, approval })))))
  ('admits $actionId Account custody from $surface under $approval policy and returns the real row or metadata outcome', async ({ actionId, surface, approval }) => {
    const h = await createHarness(actionId, approval);
    const input = actionId === 'projects.workspace.update' ? { serverId: 'srv_n2', workspaceId: h.ref.id, label: 'Renamed workspace' }
      : actionId === 'projects.workspace.forget' ? { serverId: 'srv_n2', workspaceId: h.ref.id }
      : actionId === 'projects.visibility.set' ? { target: { serverId: 'srv_n2', projectKey: 'project' }, expectedRevision: 2, hidden: true }
      : actionId === 'projects.context.update' ? { target: { serverId: 'srv_n2', projectKey: 'project' }, expectedRevision: 2,
        intent: { kind: 'detach', entryId: 'context-entry' } }
      : actionId === 'projects.sources.read' ? { serverId: 'srv_n2', sourceId: 'source' }
      : actionId === 'projects.sources.create' ? { serverId: 'srv_n2', requestKey: 'new-source', name: 'New source', repository }
      : actionId === 'projects.sources.update' ? { serverId: 'srv_n2', sourceId: 'source', expectedRevision: 2, patch: { name: 'Renamed source' } }
      : actionId === 'projects.sources.delete' ? { serverId: 'srv_n2', sourceId: 'source', expectedRevision: 2 }
      : { serverId: 'srv_n2' };
    try {
      const initialRows = JSON.stringify(h.rows); const initialSource = JSON.stringify(h.source());
      const pending = await h.run(input, surface);
      if (approval === 'ask') {
        expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        // These are original signed Account/terminal proposals, not the
        // Agent-Session or unsigned host-CLI proposals replayed by the app.
        expect(requiresExactDaemonApprovalReplay(await h.approval())).toBe(true);
        expect(JSON.stringify(h.rows)).toBe(initialRows);
        expect(JSON.stringify(h.source())).toBe(initialSource);
      }
      const result = approval === 'ask' ? await h.decide('approve') : pending;
      expect(result, JSON.stringify(result)).toMatchObject(approval === 'ask'
        ? { ok: true, result: { status: 'executed', execution: { ok: true } } } : { ok: true });
      const outcome = approval === 'ask' ? (await h.approval()).execution?.result : result.ok ? result.result : null;
      if (actionId === 'projects.list') expect(outcome).toMatchObject({ items: [expect.objectContaining({ rootPath: h.rootPath })] });
      else if (actionId === 'projects.workspace.update') expect(outcome).toMatchObject({ workspaceRef: { id: h.ref.id, label: 'Renamed workspace' } });
      else if (actionId === 'projects.workspace.forget') expect(h.rows.find(row => row.key.kind === 'workspace-ref')?.content).toBeNull();
      else if (actionId === 'projects.visibility.set') expect(outcome).toMatchObject({ row: { hidden: true }, revision: 3 });
      else if (actionId === 'projects.context.update') expect(outcome).toMatchObject({ row: { promptStack: [], hidden: false, pinned: false }, revision: 3 });
      else if (actionId === 'projects.sources.list') expect(outcome).toMatchObject({ sources: [{ id: 'source' }] });
      else if (actionId === 'projects.sources.read') expect(outcome).toMatchObject({ source: { id: 'source', name: 'App' } });
      else if (actionId === 'projects.sources.delete') expect(h.source()).toBeNull();
      else expect(h.source()).toMatchObject({ name: actionId === 'projects.sources.create' ? 'New source' : 'Renamed source' });
      const settledRows = JSON.stringify(h.rows); const settledSource = JSON.stringify(h.source());
      if (approval === 'ask') expect(await h.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(JSON.stringify(h.rows)).toBe(settledRows); expect(JSON.stringify(h.source())).toBe(settledSource);
      expect(await readFile(join(h.rootPath, 'original'))).toEqual(bytes);
    } finally { await h.close(); }
  });
});
