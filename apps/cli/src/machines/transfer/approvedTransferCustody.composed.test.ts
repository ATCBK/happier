import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesystemDownloadOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionAccountServerPrincipalV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ApiMachineClient } from '@/api/apiMachine';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createDirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createPreparedFilesystemTransferClient } from './preparedFilesystemTransferClient';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { prepareWorkspaceFileExport } from './prepareWorkspaceFileExport';
import type { ActionOperationRpcContext } from '@/daemon/actionOperations/actionOperationRpcHandlers';

const boundary = vi.hoisted(() => ({ home: '' }));
vi.mock('@/configuration', async importOriginal => {
  const original = await importOriginal<typeof import('@/configuration')>();
  return { ...original, configuration: { ...original.configuration,
    get happyHomeDir() { return boundary.home; }, set happyHomeDir(value: string) { boundary.home = value; },
    get logsDir() { return join(boundary.home, 'logs'); },
  } };
});
// The daemon's physical listener is replaced; installed Action admission/replay stays real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup(approvalRequired: boolean) {
  boundary.home = await mkdtemp(join(tmpdir(), 'happier-approved-transfer-'));
  const directory = boundary.home;
  const env = createEnvKeyScope(['HAPPIER_MACHINE_RPC_WORKING_DIRECTORY']);
  env.patch({ HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: directory });
  const homeId = 'srv_transfer_custody';
  const endpoint = 'https://transfer-custody.test';
  const token = (accountId: string, terminal = false) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
    provenance: { v: 1, kind: terminal ? 'terminal' : 'account', authority: terminal ? 'account_automation' : 'present_user' } })).toString('base64url')}.signature`;
  const credentials = { token: token('alice', true), encryption: null };
  const currentness = await createRequesterCurrentnessSocketHarness();
  const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
  const settings = { actionsSettingsV1: { v: 1, ...(approvalRequired
    ? { actions: { 'daemon.filesystem.download': { approvalRequiredSurfaces: ['ui'] } } }
    : { approvalWaivedSurfaces: { 'daemon.filesystem.download': ['ui'] } }) } };
  let artifact: Record<string, unknown> | undefined;
  let notifyApproval!: () => void;
  const approvalCreated = new Promise<void>(resolve => { notifyApproval = resolve; });
  const cancellation = new AbortController();
  const nativeFetch = globalThis.fetch;
  // Home HTTP is the external boundary. Artifact mode parsing, CAS transitions,
  // requester rehydration, approval execution and operation ownership remain real.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
    const target = new URL(String(url));
    if (target.origin !== endpoint) return nativeFetch(url, options);
    if (target.pathname === '/v1/account/profile') return Response.json({ id: 'bob' });
    if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') return Response.json({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } });
    throw new Error(`Unexpected Home fetch: ${target.pathname}`);
  }));
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id: String(options?.headers?.Authorization).includes(credentials.token) ? 'alice' : 'bob' } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: settings }, version: 1 } };
    if (path === '/v1/artifacts') return { status: 200, data: artifact ? [artifact] : [] };
    if (artifact && path === `/v1/artifacts/${artifact.id}`) return { status: 200, data: artifact };
    throw new Error(`Unexpected Home read: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
    if (path === '/v1/artifacts') {
      const value = readCarrierMutation(body);
      artifact = { ...value, ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      notifyApproval();
      return { status: 200, data: { id: value.id, headerVersion: 1, bodyVersion: 1 } };
    }
    if (artifact && path === `/v1/artifacts/${artifact.id}`) {
      const value = readCarrierMutation(body);
      expect(value.expectedHeaderVersion).toBe(artifact.headerVersion);
      expect(value.expectedBodyVersion).toBe(artifact.bodyVersion);
      artifact = { ...artifact, ...value, headerVersion: Number(artifact.headerVersion) + 1, bodyVersion: Number(artifact.bodyVersion) + 1 };
      return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
    }
    throw new Error(`Unexpected Home write: ${path}`);
  });
  let machine!: ApiMachineClient;
  const installed = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory,
    activeServerDir: join(directory, 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
    machineId: 'machine', custodianAccountId: 'alice', credentials,
    connectedServicesMaterializationBaseDir: join(directory, 'connected-services'), registry: new ConnectedServiceRuntimeRegistry(),
    trackedSessions: new Map(), getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    getApiMachineForSessions: () => machine,
    beforeStartup: async () => {
      await writeStoredCredentialsForServerId(homeId, credentials);
      await readOrCreateInstallationIdentity();
      machine = new ApiMachineClient(credentials.token, { id: 'machine', encryptionMode: 'plain', encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined,
      { directPeerServerLifecycle: lifecycle });
    },
    startup: { resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: homeId }) },
  });
  const installation = installed.installation!;
  const ingress = installed.runtime.externalActionIngressOwner!;
  machine.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorMessage: 'Unexpected launch' }),
    stopSession: async () => false, requestShutdown: () => {}, directTransferExport: {
      prepareExportSession: async request => {
        if (request.t !== 'workspace_file_download_v1') throw new Error('Unexpected non-file export');
        return prepareWorkspaceFileExport({ lifecycle, request, accessPolicy: { kind: 'restrictedRoots', roots: [directory] } });
      },
      releaseExportSession: transferId => { lifecycle.clearPublishedTransfer(transferId); },
    },
  }, { externalActionIngressOwner: ingress });
  const context: ActionOperationRpcContext = { machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
    installationId: installation.installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
  const invoke = async (actionId: 'daemon.filesystem.download' | 'approval.request.decide', input: unknown, requestId: string, rpc = false) => {
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const envelope = { v: 1 as const, requestId, target, input };
    const authentication = { kind: 'account' as const, tokenEpoch: 0 };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'transfer-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication, accountEncryptionMode: 'plain', machineId: 'machine',
      installationId: installation.installationId, serverIdentityId: homeId, actionId, requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target } });
    const boxed = sealExternalActionRequesterAccountContextV1({ authorization, purpose: { kind: 'external_action' },
      invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' }, installationPublicKey: decodeBase64(installation.publicKey, 'base64url'),
      credentials: { token: token('bob') }, randomBytes: length => new Uint8Array(randomBytes(length)) });
    if (rpc) {
      const prepared = await ingress.prepareRequesterAccountContext!({ authorization: boxed });
      if (!prepared) throw new Error('Requester RPC custody was not admitted');
      try {
        const result = await machine.invokeLocalMachineAction(RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD,
          createTargetedActionRpcRequestV1(input, target), { rpcContext: { ...context, signal: cancellation.signal,
            transportRequestId: requestId, callerAuthority: 'present_user', callerInputAuthorization: prepared.authorization },
            localActionContext: { surface: 'ui', authority: 'present_user', actionRequestId: requestId } });
        const failure = ActionExecuteFailureSchema.safeParse(result);
        return failure.success ? failure.data : { ok: true as const, result };
      } finally { await prepared.dispose(); }
    }
    const outcome = await executeExternalAction({ actionId, envelope, surface: 'ui', signal: cancellation.signal,
      principal: ExternalActionAccountServerPrincipalV1Schema.parse({ accountId: 'bob', authentication, authority: 'present_user' }),
      currentMachineId: 'machine', currentServerId: homeId, currentServerHttpBaseUrl: endpoint, currentInstallationId: installation.installationId,
      executionAuthorization: boxed, externalActionMachineRequestPrivateKey: decodeBase64(installation.privateKey, 'base64url'),
      verifyExecutionAuthorization: async () => true, prepareRequesterAccountContext: ingress.prepareRequesterAccountContext,
      resolveTarget: ingress.resolveTarget, resolveEncryption: ingress.resolveEncryption, executor: ingress.executor });
    if (outcome.kind !== 'response') throw new Error(`Unexpected ingress result: ${JSON.stringify(outcome)}`);
    return outcome.response.execution;
  };
  const list = async (requester = true) => ActionOperationListV1ResponseSchema.parse(await machine.invokeLocalMachineAction(
    ACTION_OPERATION_RPC_METHODS_V2.list, {}, requester ? { rpcContext: context } : undefined));
  return { directory, lifecycle, invoke, approvalCreated, list,
    approve: async () => invoke('approval.request.decide', { artifactId: artifact?.id, decision: 'approve' }, 'approve-download'),
    read: async (operationId: string) => ActionOperationGetV1ResponseSchema.parse(await machine.invokeLocalMachineAction(
      ACTION_OPERATION_RPC_METHODS_V2.get, { operationId, waitForTerminal: true }, { rpcContext: context })),
    close: async () => { cancellation.abort(); try { await lifecycle.stop(); await installed.dispose(); await machine.shutdown(); await currentness.close(); }
      finally { env.restore(); await rm(directory, { recursive: true, force: true }); } },
  };
}

describe('installed filesystem Action operation custody', () => {
  it.each(['decision', 'direct', 'rpcDecision', 'rpcDirect'] as const)('retains requester download custody through %s', async route => {
    const needsApproval = route === 'decision' || route === 'rpcDecision';
    const fixture = await setup(needsApproval);
    try {
      const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
      await writeFile(join(fixture.directory, 'annotation.png'), bytes);
      let operationId: string | undefined;
      const client = createPreparedFilesystemTransferClient({
        executeAction: async (actionId, input) => {
          if (actionId !== 'daemon.filesystem.download') throw new Error(`Unexpected Action: ${actionId}`);
          const result = await fixture.invoke(actionId, input, 'annotation-download', route === 'rpcDecision' || route === 'rpcDirect');
          const receipt = FilesystemDownloadOutputSchema.safeParse(result.ok ? result.result : null);
          if (receipt.success && receipt.data.success && receipt.data.status === 'accepted') operationId = receipt.data.operationId;
          return result;
        },
        openMachineTunnel: async () => {
          expect((await fixture.list()).items).toMatchObject([{ operationId, actionId: 'daemon.filesystem.download',
            requestId: 'annotation-download', state: 'running' }]);
          expect((await fixture.list(false)).items).toEqual([]);
          return { localPort: await fixture.lifecycle.ensureListening(), observedPath: 'direct', close: async () => {} };
        },
      });
      const downloading = client.download({ targetMachineId: 'machine', rootPath: fixture.directory, path: 'annotation.png', asZip: false,
        destinationId: 'annotation-reader', destinationPath: join(fixture.directory, 'read-back.png') });
      if (needsApproval) {
        await Promise.race([fixture.approvalCreated, downloading.then(result => {
          throw new Error(`Download settled before requesting approval: ${JSON.stringify(result)}`);
        })]);
        expect((await fixture.list()).items).toEqual([]);
        await fixture.approve();
      }
      const downloaded = await downloading;
      expect(downloaded, JSON.stringify(downloaded)).toMatchObject({ success: true, status: 'completed', destinationId: 'annotation-reader', sizeBytes: bytes.length });
      expect(await readFile(join(fixture.directory, 'read-back.png'))).toEqual(bytes);
      if (!operationId) throw new Error('Expected the admitted operation identity');
      expect(await fixture.read(operationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
      if (needsApproval) { await fixture.approve(); expect((await fixture.list()).items).toHaveLength(1); }
    } finally { await fixture.close(); }
  });
});
