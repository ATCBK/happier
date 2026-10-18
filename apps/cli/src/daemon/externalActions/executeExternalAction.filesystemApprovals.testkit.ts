import { expect, vi } from 'vitest';
import axios from 'axios';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, type ActionExecuteResult, type ActionId,
  type ExternalActionExecutionAuthorizationV1, type ExternalActionRequestEnvelopeV1 } from '@happier-dev/protocol/actions';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';
import { AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
  MachineUpdateOperationProtocolCapabilitiesResponseV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ApprovalRequestV2Schema, requiresExactDaemonApprovalReplay } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowV1Schema, ProjectAccountRowListResponseV1Schema,
  ProjectAccountRowMutationResponseV1Schema, buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
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
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { configuration, reloadConfiguration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { readStoredCredentialsForServerId, sameStoredCredentials, updateSettings, writeStoredCredentialsForServerId } from '@/persistence';
import { verifyExternalActionExecutionAuthorizationCurrent, resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { executeExternalAction } from './executeExternalAction';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { reviewProjectSetupEffect } from '@/workspaces/projectSetup/projectSetupPreparation';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import type { PtyProcess, PtyExitEvent } from '@/terminal/pty/provider';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { prepareWorkspaceSyncBetween } from '@/workspaces/sync/workspaceSyncPreparation';

// OS process boundary only; the installed operation, preparation, success and PTY owners stay real.
class SetupBoundaryPty implements PtyProcess {
  constructor(readonly pid: number) {}
  get ownedProcessGroupId() { return this.pid; }
  private readonly exits = new Set<(event: PtyExitEvent) => void>();
  write() {}
  resize() {}
  kill() {}
  onData() { return { dispose() {} }; }
  onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
  exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode }); }
}

const socketBoundary = vi.hoisted(() => ({ create: vi.fn() }));
export function resetFilesystemApprovalSocketBoundary() { socketBoundary.create.mockReset(); }
vi.mock('socket.io-client', async importOriginal => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return { ...actual, io: (...args: Parameters<typeof actual.io>) => socketBoundary.create.getMockImplementation()
    ? socketBoundary.create(...args) : actual.io(...args) };
});
const bytes = Buffer.from([0, 255, 128, 10]);
const repository = { provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git' }, protocol: 'https' as const };

// Extend the incumbent continuation harness. Production composition/registrars,
// policy, custody, codecs and effects remain real; Home transport and durable
// approval persistence are the only substituted system boundaries.
export async function createHarness(actionId: ActionId, approval: 'ask' | 'allowed' = 'ask', setup = false, homeId = 'srv_n2',
  home?: Readonly<{
    token: string;
    mintAuthorization(actionId: ActionId, envelope: ExternalActionRequestEnvelopeV1, authentication: Readonly<{ kind: 'account' | 'terminal'; tokenEpoch: number }>): Promise<ExternalActionExecutionAuthorizationV1>;
    request(input: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown; headers: Record<string, string> }>): Promise<{ status: number; data: unknown }>;
  }>, worker = false) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-action-composition-'));
  const rootPath = join(directory, 'accepted');
  await mkdir(rootPath); await writeFile(join(rootPath, 'original'), bytes);
  if (actionId === 'projects.script.run' || worker) {
    await writeFile(join(rootPath, 'Makefile'), 'check:\n\t@echo replay-admitted\n');
    await mkdir(join(rootPath, '.happier'));
    await writeFile(join(rootPath, '.happier/project.json'), JSON.stringify({ version: 1,
      ...(setup ? { workspace: { setup: [{ kind: 'command', command: 'echo setup-reviewed' }] } } : {}),
      scripts: { lint: { ...(worker ? { execution: 'portable' } : {}), source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } }));
  }
  if (actionId === 'localServices.launcher.start') {
    await mkdir(join(rootPath, '.happier'));
    await writeFile(join(rootPath, '.happier/project.json'), JSON.stringify({ version: 1,
      ...(setup ? { workspace: { setup: [{ kind: 'command', command: 'echo setup-reviewed' }] } } : {}),
      services: { checked: { source: { kind: 'command', command: 'echo service-admitted' } } } }));
  }
  await writeFile(join(directory, 'outside'), 'outside unchanged');
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_MACHINE_RPC_WORKING_DIRECTORY']);
  env.patch({ HAPPIER_HOME_DIR: join(directory, 'srv_n2'), HAPPIER_ACTIVE_SERVER_ID: 'srv_n2',
    HAPPIER_SERVER_URL: 'https://home.example.test', HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: directory });
  reloadConfiguration();
  expect(configuration.activeServerId).toBe('srv_n2');
  const token = home?.token ?? 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url') + '.signature';
  // The app's original Account HTTP request has current provenance. The
  // installed daemon keeps its independent retained credential fixture.
  const uiToken = home?.token ?? 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url') + '.signature';
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  await updateSettings(settings => ({ ...settings, activeServerId: 'srv_n2', servers: { srv_n2: { id: 'srv_n2', name: 'Home',
    homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
      canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] }),
    serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 } } }));
  await writeStoredCredentialsForServerId('srv_n2', credentials);
  const installation = await readOrCreateInstallationIdentity();
  const privateKey = Buffer.from(installation.privateKey, 'base64url');
  const publicKey = Buffer.from(installation.publicKey, 'base64url');
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const ref = { id: 'workspace', serverId: homeId, machineId: worker ? 'source-machine' : target.machineId, rootPath, projectKey: 'project', createdAtMs: 1 };
  const workerRoot = join(directory, 'worker');
  if (worker) await mkdir(workerRoot);
  const workerRef = { ...ref, id: 'worker-ref', machineId: target.machineId, rootPath: workerRoot };
  const basePolicy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const relationship = WorkspaceSyncRelationshipV1Schema.parse({ v: 1, relationshipId: 'source-worker', controllerMachineId: ref.machineId,
    alphaWorkspaceRefId: ref.id, betaWorkspaceRefId: workerRef.id, mode: 'keep_synced', enabled: true,
    provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: ref.id, targetWorkspaceRefId: workerRef.id },
    contentPolicy: { ...basePolicy, policyDigest: computeWorkspaceSyncPolicyDigest(basePolicy) }, createdAtMs: 1, updatedAtMs: 1 });
  const refKey = { kind: 'workspace-ref' as const, serverId: homeId, id: ref.id };
  const organizationKey = { kind: 'project-organization' as const, serverId: homeId, projectKey: 'project' };
  const rows: ProjectAccountRowV1[] = [
    { key: refKey, revision: 2, content: { t: 'plain', v: { key: refKey, value: ref } } },
    { key: organizationKey, revision: 2, content: { t: 'plain', v: { key: organizationKey, value: { hidden: false, pinned: false,
      promptStack: [{ id: 'context-entry', enabled: true, placement: 'system_append', ref: { kind: 'doc', artifactId: 'context-doc' } }] } } } },
  ].map(row => ProjectAccountRowV1Schema.parse(row));
  if (worker) {
    const key = { kind: 'workspace-ref' as const, serverId: homeId, id: workerRef.id };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 1, content: { t: 'plain', v: { key, value: workerRef } } }));
    const graphKey = { kind: 'relationship-graph' as const };
    rows.push(ProjectAccountRowV1Schema.parse({ key: graphKey, revision: 1, content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } }));
  }
  let sourceAccountId = 'account';
  let encryptionVersion = 1;
  let copies = 0;
  let afterCopy: (() => void) | undefined;
  const sourceHandlers = new Map<string, (input: unknown, context?: import('@/api/rpc/types').RpcHandlerContext) => Promise<unknown>>();
  const accountSettings = { actionsSettingsV1: { v: 1, actions: approval === 'ask'
    ? { [actionId]: { approvalRequiredSurfaces: ['ui', 'rpc', 'cli'] } } : {},
    ...(approval === 'allowed' ? { approvalWaivedSurfaces: { [actionId]: ['ui', 'rpc', 'cli'] } } : {}) } };
  let artifact: Readonly<Record<string, unknown>> | undefined;
  let source: ProjectSourceV1 | null = { id: 'source', revision: 2, name: 'App', repository, audience: [], createdByAccountId: 'account' };
  const networkPaths: string[] = [];
  const rpcOutcomes: unknown[] = [];
  const homeRequest = (method: 'GET' | 'POST', path: string, body: unknown, headers: unknown) => {
    if (!home || !headers || typeof headers !== 'object' || !Object.hasOwn(headers, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)) return null;
    return home.request({ method, path, ...(body === undefined ? {} : { body }), headers: Object.fromEntries(
      Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
  };
  let trustRead: Promise<void> = Promise.resolve();
  let releaseTrustRead = () => {};
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    networkPaths.push('GET ' + path);
    const admitted = homeRequest('GET', path, undefined, options?.headers);
    if (admitted) return await admitted;
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'account' } };
    if (path === '/v1/account/security') return { status: 200, data: AccountSecurityGetResponseV1Schema.parse({
      v: 1, encryptionMode: 'plain', terminalPresentUserPolicy: 'allowed', nativeEmail: null,
      password: { status: 'not_enrolled', revision: null },
    }) };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: encryptionVersion } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: accountSettings }, version: 1 } };
    if (path === '/v1/artifacts') return { status: 200, data: artifact ? [artifact] : [] };
    if (artifact && path === '/v1/artifacts/' + artifact.id) return { status: 200, data: artifact };
    if (path === '/v1/account/authoring-memory') return { status: 200, data: { rows: [] } };
    if (worker && path === '/v1/machines/source-machine') return { status: 200, data: { machine: { id: ref.machineId,
      kind: 'persistent', active: true, storageMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      installationId: 'source-installation', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: sourceAccountId, displayName: 'Source Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
    if (path === '/v1/machines/machine') return { status: 200, data: { machine: { id: 'machine', kind: 'persistent', active: true, storageMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      installationId: installation.installationId, installationPublicKey: publicKey.toString('base64'),
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
    if (path === '/v1/machines') return { status: 200, data: [{ id: 'machine', active: true, kind: 'persistent',
      installationId: installation.installationId, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }] };
    throw new Error('Unexpected Home GET ' + path);
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    networkPaths.push('FETCH ' + path);
    if (path !== '/v1/features' && path !== '/v1/features/authenticated') throw new Error('Unexpected Home fetch ' + path);
    return Response.json({ features: actionId === 'localServices.launcher.start' ? { localServices: { enabled: true,
      inventory: { enabled: true }, launcher: { enabled: true }, actions: { enabled: true }, managed: { enabled: true } },
      browser: { enabled: true, viewTargets: { enabled: true } } } : {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } });
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    const path = new URL(String(url)).pathname;
    networkPaths.push('POST ' + path);
    const admitted = homeRequest('POST', path, body, options?.headers);
    if (admitted) return await admitted;
    if (path === '/v1/actions/projects.inspect/execution-authorization') {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 200, data: home ? await home.mintAuthorization('projects.inspect', request.envelope)
        : ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'inspection-home-root', binding: {
          accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
          accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: request.machineId,
          installationId: request.machineId === target.machineId ? installation.installationId : 'source-installation', actionId: 'projects.inspect', requestId: request.envelope.requestId,
          target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        } }) };
    }
    if (path === '/v1/actions/projects.inspect') {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const authorization = request.executionAuthorization;
      if (!authorization || !('authentication' in authorization.binding)) throw new Error('Missing inspection Account admission');
      if (worker && request.machineId === ref.machineId) {
        const handler = sourceHandlers.get(getActionSpec('projects.inspect').bindings!.rpcMethod!);
        if (!handler) throw new Error('Missing real SOURCE registrar');
        const result = await handler(request.envelope.input, { signal: new AbortController().signal, callerAuthority: 'present_user' });
        return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect',
          requestId: request.envelope.requestId, execution: { ok: true, result } }) };
      }
      const result = await executeExternalAction({ actionId: 'projects.inspect', envelope: request.envelope,
        principal: { accountId: 'account', authority: 'present_user', authentication: authorization.binding.authentication },
        surface: 'ui', executionAuthorization: authorization, currentMachineId: target.machineId, currentServerId: 'srv_n2',
        currentServerHttpBaseUrl: params.serverHttpBaseUrl, currentInstallationId: installation.installationId,
        externalActionMachineRequestPrivateKey: privateKey, verifyExecutionAuthorization: verifyRoot,
        resolveTarget, executor: owner, prepareRequesterAccountContext: prepareRequester });
      if (result.kind !== 'response') throw new Error('Inspection ingress refused');
      return { status: 200, data: result.response };
    }
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
    if (path === '/v1/account/project-trust/read') {
      await trustRead;
      return { status: 200, data: { status: 'absent' } };
    }
    if (path === '/v1/account/project-rows/list') return { status: 200,
      data: ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows }) };
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
      // The production row writer's output must also satisfy the server response
      // consumer; parsing only the request would hide response-shape drift.
      return { status: 200, data: ProjectAccountRowMutationResponseV1Schema.parse({ status: 'updated', rows: changes, cursor: 3 }) };
    }
    throw new Error('Unexpected Home POST ' + path);
  });
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    const path = new URL(String(request.url)).pathname;
    networkPaths.push(String(request.method) + ' ' + path);
    const admitted = request.method === 'GET' || request.method === 'POST'
      ? homeRequest(request.method, path, request.data, request.headers) : null;
    if (admitted) return await admitted;
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) return { status: 200, data: { status: 'absent' } };
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
  const finiteIngress: Array<{ accountId: string; homeId: string; installationId: string; current: boolean }> = [];
  const workerAdmission = createProjectWorkerAdmission({ machineId: target.machineId,
    admissionDrain: createDaemonAdmissionDrain(), readPolicy: async () => ({ status: 'ready',
      policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) });
  const nativeIo = createProjectNativeIo();
  const spawned: SetupBoundaryPty[] = [];
  const spawnWaiters = new Map<number, (pty: SetupBoundaryPty) => void>();
  const setupTerminals = setup || worker ? createTerminalPtySessionManager({
    ptyProvider: { spawn() {
      const index = spawned.length;
      const pty = new SetupBoundaryPty(3456 + index);
      spawned.push(pty); spawnWaiters.get(index)?.(pty); spawnWaiters.delete(index);
      return pty;
    } },
    config: readDaemonTerminalPtyConfig({}).sessionManager,
    env: {}, platform: 'linux', stopProcessTree: async () => {}, probeProcessGroup: () => 'absent',
  }) : undefined;
  const client = new ApiMachineClient(token, { id: target.machineId, encryptionMode: 'plain', metadata: null,
    metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined, {
      createProjectFiniteRuntime: async (ports, ingress) => {
        const runtime = await createInstalledProjectFiniteRuntime({ api, credentials, externalActionAccountId: 'account',
          finiteServerId: 'srv_n2', finiteServerHttpBaseUrl: 'https://home.example.test', registeredMachineId: target.machineId,
          admission: workerAdmission, nativeIo: { ...nativeIo,
            ...(setupTerminals ? { commandIo: { ...nativeIo.commandIo, resolveTool: async tool => ({ executablePath: `/managed/${tool}`, version: '1' }) } } : {}) },
          successHomeDir: join(directory, 'setup-success'), resolveCurrentMachineExecutionOriginContext: resolveOrigin,
          isCurrent: async () => sameStoredCredentials(credentials, await readStoredCredentialsForServerId('srv_n2')),
          prepareBetween: async (request, signal) => {
            if (!worker) throw new Error('Unexpected worker copy');
            return await prepareWorkspaceSyncBetween({ ...request, serverId: homeId, signal,
              readCurrent: async () => ({ workspaceRefs: [ref, workerRef], relationships: [relationship] }),
              // Only the remote controller's completed filesystem transfer is substituted.
              flush: async () => { copies++; await cp(rootPath, workerRoot, { recursive: true }); afterCopy?.();
                return { relationshipId: relationship.relationshipId, controllerMachineId: ref.machineId, state: 'watching',
                  alphaPath: rootPath, betaPath: workerRoot, mode: relationship.mode,
                  endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                    beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
                  conflictCount: 0, lastCycleObservedAtMs: 5, lastCleanSyncAtMs: 5 };
              } });
          },
        })({ ...ports, ...(setupTerminals ? { terminalSessions: setupTerminals } : {}) }, ingress);
        if (runtime) finiteIngress.push({ accountId: runtime.accountId, homeId: runtime.accountAuthorization?.binding.serverIdentityId ?? homeId,
          installationId: ingress.machineAdmission!.installationId, current: await runtime.isCurrent!() });
        return runtime;
      },
    });
  const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing production RPC manager');
  const rpc = manager;
  const admission = { actorAccountId: 'account', custodianAccountId: 'account', machineId: target.machineId,
    installationId: installation.installationId, role: 'manage' as const, encryptionMode: 'plain' as const };
  let installedSocket: ReturnType<typeof createApiSessionSocketStub> | undefined;
  socketBoundary.create.mockImplementation((_url: unknown, options?: Readonly<{ auth?: Readonly<{ clientType?: string }> }>) => {
    const boundary = createApiSessionSocketStub();
    if (options?.auth?.clientType === 'machine-scoped') installedSocket = boundary;
    const socket = Object.assign(boundary, {
      emitWithAck: async (event: string, packet: Readonly<{ method: string; params: unknown; requestId?: string;
        originalActionEnvelope?: Parameters<typeof executeExternalAction>[0]['envelope'];
        externalActionExecution?: Readonly<{ authorization: NonNullable<import('@happier-dev/protocol/actions').ActionExecutorContext['externalActionExecutionAuthorization']>;
          machineSignature: string; effectActionId: string; target: typeof target; installationId: string }> }>) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          expect(MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(packet).machineId).toBe(target.machineId);
          return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse({ v: 1, result: 'success', revision: 1 });
        }
        if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error('Unexpected socket event ' + event);
        const execution = packet.externalActionExecution;
        if (execution?.authorization.requesterAccountContext) {
          const opensFor = (method: string) => openExternalActionRequesterAccountContextV1({ authorization: execution.authorization,
            purpose: { kind: 'machine_rpc', method, params: packet.params }, machineId: target.machineId,
            installationId: installation.installationId, serverIdentityId: homeId, installationPrivateKey: privateKey }) !== null;
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
  const params = { token, credentials, sessionId: '', mode: 'plain' as const, ctx: null, serverId: 'srv_n2', serverIdentityId: homeId,
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
  const api = await ApiClient.create(credentials);
  if (worker) registerProjectDefinitionHandlers({ machineId: ref.machineId,
    rpcHandlerManager: { registerHandler: (method, handler) => { sourceHandlers.set(method, handler); } },
    actionExecutor: createActionExecutor(createCliActionDeps({ token, credentials, serverId: 'srv_n2',
      serverHttpBaseUrl: 'https://home.example.test', sessionId: 'source', mode: 'plain', ctx: null,
      projectDefinitionAction: createProjectDefinitionAction({ serverId: 'srv_n2', machineId: ref.machineId,
        workingDirectory: rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] }, nativeIo: {
          ...nativeIo.commandIo, resolveTool: async tool => ({ executablePath: `/managed/${tool}`, version: '1' }) } }) })) });
  const features = actionId === 'localServices.launcher.start' ? await api.getServerFeaturesSnapshot({ refresh: true }) : undefined;
  api.setServerFeaturesSnapshotProvider(() => features);
  const runtimeActionExecute = api.createBrowserRuntimeActionExecutor();
  const runtime = await startDaemonSessionControlRuntime({ machineId: target.machineId, credentials,
    serverId: 'srv_n2', serverBaseUrl: params.serverHttpBaseUrl, externalActionAccountId: 'account',
    api, connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
    ...(actionId === 'localServices.launcher.start' ? { runtimeActionExecute, resolveServerFeaturesSnapshot: () => features } : {}),
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
  if (actionId === 'projects.open') {
    // The real installed Open receiver is reached on a connected Machine.
    // Connect the public client rather than bypassing its live transport check.
    client.connect();
    await expect.poll(() => installedSocket?.connected).toBe(true);
  }
  const store = createCliApprovalsArtifactStore({ credentials, serverId: 'srv_n2' });
  const issuerParams = { ...params, ...(features ? { resolveServerFeaturesSnapshot: () => features } : {}) };
  const deciding = createCliActionExecutorHarness(issuerParams, { isApprovalExecutionOriginCurrent: originCurrent,
    approvalRequestApprovedReplay: async ({ artifactId, request }): Promise<ActionExecuteResult | null> => {
      if (!requiresExactDaemonApprovalReplay(request)) return null;
      return await harness.run({ artifactId, decision: 'approve', serverIdentityId: homeId,
        originServerId: request.v === 2 ? request.executionOriginV1.serverId : 'srv_n2' }, 'ui', false, 'present_user', 'approval.request.decide', 'reviewer-request');
    } }).executor;
  const issuer = createCliActionExecutorHarness(issuerParams).executor;
  // The app captures the portable Home; the daemon/decider has its own local
  // profile label for that same Home, as in LV2's two-device replay.
  const uiIssuer = createCliActionExecutorHarness({ ...issuerParams, token: uiToken,
    credentials: { ...credentials, token: uiToken }, serverId: homeId }).executor;
  const artifactId = () => { if (!artifact) throw new Error('Missing approval Artifact'); return String(artifact.id); };
  const ownOperations = new Set<string>();
  const retainOperation = (value: unknown) => {
    const parsed = ProjectCommandActionOutputV1Schema.safeParse(value);
    if (parsed.success) ownOperations.add(parsed.data.operation.operationId);
  };
  const harness = { rootPath, directory, ref, workerRef, rows, rpcOutcomes, networkPaths, finiteIngress, spawned, installation,
    copies: () => copies, foreignSource: () => { sourceAccountId = 'foreign'; }, retireAfterCopy: () => { afterCopy = () => { encryptionVersion++; }; },
    disconnectInstalledMachine: () => installedSocket?.disconnect(),
    source: () => source, hasApproval: () => artifact !== undefined,
    reviewSetup: () => reviewProjectSetupEffect({ workspace: ref,
      projectAssociation: { workspace: ref, project: { serverId: homeId, projectId: ref.projectKey } },
      requester: { credentials, serverHttpBaseUrl: params.serverHttpBaseUrl }, purpose: 'setup',
      platform: { os: process.platform, arch: process.arch }, nativeIo: { ...nativeIo.commandIo,
        resolveTool: async tool => ({ executablePath: `/managed/${tool}`, version: '1' }) },
    }),
    approval: async () => {
      const request = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: artifactId() }));
      if (request.execution?.ok) retainOperation(request.execution.result);
      return request;
    },
    decide: (decision: 'approve' | 'reject' | 'cancel', authority: 'present_user' | 'account_automation' = 'present_user') =>
      deciding.execute('approval.request.decide', { artifactId: artifactId(), decision }, { surface: 'ui', authority }),
    replay: () => rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId: artifactId() }),
    localFinite: (input: unknown) => rpc.invokeLocal(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run'], input),
    readOperation: (operationId: string) => rpc.invokeLocal('actionOperation.get.v2', { operationId }),
    readReviewedOperation: (operationId: string) => rpc.invokeLocal('actionOperation.get.v2', { operationId, refreshSetupReview: true }),
    waitForTerminal: (operationId: string) => rpc.invokeLocal('actionOperation.get.v2', { operationId, waitForTerminal: true }),
    waitForSpawn(index: number) {
      const present = spawned[index];
      return present ? Promise.resolve(present) : new Promise<SetupBoundaryPty>(resolve => { spawnWaiters.set(index, resolve); });
    },
    cancelOperation: (operationId: string) => rpc.invokeLocal('actionOperation.cancel.v1', { operationId }),
    unadmittedPeerCancel: (operationId: string) => client.getPeerMediationMachineRpcHandlerManager()
      .invokeLocal('actionOperation.cancel.v1', { operationId }),
    readTransportOperation: (operationId: string, timeoutMs: number) => rpc.handleRequest({
      method: 'machine:actionOperation.get.v2', params: { operationId }, machineAdmission: admission, timeoutMs }),
    holdTrustRead() {
      trustRead = new Promise<void>(resolve => { releaseTrustRead = resolve; });
      return () => { releaseTrustRead(); trustRead = Promise.resolve(); };
    },
    async serviceInput() {
      const result = await runtimeActionExecute({ actionId: 'localServices.launcher.snapshot',
        input: { machineId: target.machineId, scope: 'workspace', workspaceRoot: rootPath }, context: { serverId: 'srv_n2' } });
      expect(result, JSON.stringify(result)).not.toHaveProperty('errorCode');
      const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(result);
      const declaration = snapshot.targets.find(candidate => candidate.declaration);
      if (!declaration) throw new Error('Accepted Service declaration unavailable');
      return { machineId: target.machineId,
        targetId: declaration.id, workspace: { serverId: 'srv_n2', workspaceId: ref.id, machineId: target.machineId, rootPath },
        declaration: declaration.declaration };
    },
    async run(input: unknown, surface: 'ui' | 'cli', proposalAtIssuer: boolean | 'unsigned-ui' = false,
      authority: 'present_user' | 'account_automation' = 'account_automation', requestedActionId: ActionId = actionId,
      requestId = 'original-request'): Promise<ActionExecuteResult> {
      const authentication = { kind: surface === 'cli' ? 'terminal' as const : 'account' as const, tokenEpoch: 1 };
      const envelope = { v: 1 as const, requestId, target, input };
      const authorization = home ? await home.mintAuthorization(requestedActionId, envelope, authentication)
        : { v: 1 as const, token: 'synthetic-home-root', binding: { accountId: 'account', custodianAccountId: 'account',
        authentication, accountEncryptionMode: 'plain' as const, serverIdentityId: homeId, machineId: target.machineId,
        installationId: installation.installationId, actionId: requestedActionId, requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } };
      expect(ExternalActionExecutionAuthorizationV1Schema.safeParse(authorization).success).toBe(true);
      expect(ExternalActionRequestEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect(await resolveOrigin()).toEqual({ serverIdentityId: homeId, machineId: target.machineId });
      if (proposalAtIssuer) {
        // A CLI-issued Ask has not entered the Machine's operation runner.
        // Replay still enters its actual installed registrar/executor below.
        const prepared = await prepareRequester?.({ authorization });
        if (!prepared) throw new Error('Requester admission unavailable');
        try {
          return await (proposalAtIssuer === 'unsigned-ui' ? uiIssuer : issuer).execute(requestedActionId, input, { surface, authority,
            serverId: 'srv_n2', serverIdentityId: homeId, runtimeAccountId: 'account',
            actionRequestId: envelope.requestId,
            ...(proposalAtIssuer === 'unsigned-ui' ? {} : { defaultSessionMachineId: target.machineId,
            externalActionTarget: target, externalActionExecutionAuthorization: prepared.authorization,
            signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({
              authorizationToken: args.authorization.token, actionId: args.actionId, input: args.input,
              target: args.target, privateKey }) }),
          });
        } finally { await prepared.dispose?.(); }
      }
      const result = await executeExternalAction({ actionId: requestedActionId, envelope, principal: { accountId: 'account', authority,
        authentication: 'authentication' in authorization.binding ? authorization.binding.authentication : authentication },
        surface, executionAuthorization: authorization, currentMachineId: target.machineId, currentServerId: 'srv_n2',
        currentServerHttpBaseUrl: params.serverHttpBaseUrl, currentInstallationId: installation.installationId,
        externalActionMachineRequestPrivateKey: privateKey, verifyExecutionAuthorization: verifyRoot,
        resolveTarget, executor: owner, prepareRequesterAccountContext: prepareRequester });
      expect(result.kind, JSON.stringify({ result, networkPaths })).toBe('response');
      if (result.kind !== 'response') throw new Error('External Action ingress refused');
      if (result.response.execution.ok) retainOperation(result.response.execution.result);
      return result.response.execution;
    },
    raw: (input: unknown, requestId: string | null = 'original-request') => rpc.handleRequest({ method: target.machineId + ':' + actionId,
      params: input, ...(requestId ? { requestId } : {}), callerAuthority: 'present_user', machineAdmission: admission }),
    async close() {
      releaseTrustRead();
      for (const operationId of ownOperations) await rpc.invokeLocal('actionOperation.cancel.v1', { operationId });
      spawned.forEach(pty => pty.exit(0)); setupTerminals?.dispose();
      await runtime.stopControlServer(); await client.shutdown(); env.restore(); reloadConfiguration(); await rm(directory, { recursive: true, force: true });
    },
  };
  return harness;
}

