import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcess } from 'node:child_process';
import { accountSettingsParse, FeaturesResponseSchema, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { AgentExecutionTargetV1Schema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { configuration } from '@/configuration';
import { ApiClient } from '@/api/api';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  commitActiveAcpCatalog, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { AgentRuntimeRunnerBootstrapV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { resolveAccountConfiguredAcpLaunchForAgent } from '@/agent/runtime/registry/engineRegistry/accountConfiguredAcp';
import { createCustomAcpAdmissionRuntimeFixture } from './customAcpAdmission.testkit';
import { executeSpawnSessionRequest, type ExecuteSpawnSessionRequestParams } from './executeSpawnSessionRequest';
import { SpawnSessionControlErrorResponseSchema, projectSpawnSessionControlErrorResponse } from '@/session/shared/spawnSessionContract';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { resolveTrackedSessionTerminalPresentation } from '../sessions/resolveTrackedSessionTerminalPresentation';
import { projectResolvedAgentBackendTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import { requireCatalogEntry } from '@/agent/catalog/registry';
import { buildHappySessionControlArgs } from '../sessionSpawnArgs';
import { resolveDaemonCliSubcommandFromBackendTarget } from '../backendTargetRouting';
import { HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '../agentRuntime/sessionBridgeAuthorization';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { logger } from '@/ui/logger';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import type { TrackedSession } from '../types';
import { resolveEntrypointIdentityFromLaunchSpec } from '../sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { readProcessIdentityByPid } from '../processIdentity';
import * as processTermination from '@/processes/terminate/terminateProcessTree';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { createOnChildExited } from '../sessions/onChildExited';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema,
  StoredSessionOwnerMetadataEnvelopeV1Schema, StoredSessionSharedMetadataV1Schema,
  projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readPermissionModeIntentFromMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { V2SessionByIdResponseSchema, type V2SessionByIdResponse } from '@happier-dev/protocol/sessions/control/contract';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

const storage = vi.hoisted(() => ({ home: '', persistedToken: 'df38-owner-token',
  credentials: { token: 'df38-owner-token', encryption: null }, io: vi.fn(),
  runnerCommand: '', runnerExited: false, sourceChecks: null as Array<{ command: string; args: string[] }> | null,
  runnerBootstrapPath: '',
  runnerWrapperPid: 0,
  runnerLaunches: [] as Array<{ command: string; args: string[] }>,
  runnerSpawn: null as ((args: string[], env: NodeJS.ProcessEnv) => import('node:child_process').ChildProcess) | null,
  daemonPort: 0, daemonControlToken: '' }));
vi.mock('socket.io-client', () => ({ io: storage.io }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const [command, argv] = args;
    if (storage.sourceChecks && command === process.execPath && Array.isArray(argv)
      && argv[0] === join(process.cwd(), 'scripts', 'syncSharedDepsForDev.mjs') && argv[1] === '--check') {
      // Source distribution publication is an external process boundary. This
      // composed source test exercises the real preflight without building or
      // installing another CLI representation. Vendor ACP spawns stay real.
      storage.sourceChecks.push({ command, args: [...argv] });
      const processCheck = new actual.ChildProcess();
      process.nextTick(() => processCheck.emit('close', 0, null));
      return processCheck;
    }
    const options = args[2];
    if (storage.runnerSpawn && storage.runnerBootstrapPath && Array.isArray(argv)
      && options?.env?.HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE === storage.runnerBootstrapPath) {
      storage.runnerLaunches.push({ command, args: [...argv] });
      const entrypoint = resolveEntrypointIdentityFromLaunchSpec({ filePath: command, args: argv });
      if (entrypoint.status !== 'known') throw new Error('Own runner launch has no canonical CLI entrypoint');
      // The route's published startup argv precedes the Session control args.
      // Its physical entrypoint can be source, admitted dist or a binary; the
      // exact private bootstrap scopes this OS adapter to this one child.
      const startupFlagIndex = argv.indexOf('--happy-starting-mode');
      if (startupFlagIndex < 1) throw new Error('Own runner omitted the installed CLI startup contract');
      storage.runnerCommand = [command, ...argv].join(' ');
      const runChild = storage.runnerSpawn;
      storage.runnerSpawn = null;
      return runChild(argv.slice(startupFlagIndex - 1), options.env);
    }
    return actual.spawn(...args);
  } };
});
// The in-process child retains real admission and runtime code; only its OS
// process command identity differs from Vitest's actual worker command.
vi.mock('../processIdentity', async importOriginal => {
  const actual = await importOriginal<typeof import('../processIdentity')>();
  return { ...actual, readProcessIdentityByPid: async (pid: number) => storage.runnerCommand && (pid === process.pid || pid === storage.runnerWrapperPid)
    ? storage.runnerExited ? null : { pid, command: storage.runnerCommand, processStartTimeMs: pid === storage.runnerWrapperPid ? 2 : 1 }
    : await actual.readProcessIdentityByPid(pid) };
});
vi.mock('../processRunState', async importOriginal => {
  const actual = await importOriginal<typeof import('../processRunState')>();
  return { ...actual, readProcessRunState: async (pid: number) => storage.runnerCommand && (pid === process.pid || pid === storage.runnerWrapperPid)
    ? storage.runnerExited ? 'dead' : 'servable'
    : await actual.readProcessRunState(pid) };
});
// OS/environment boundaries only: real admission, catalog, activation, Account custody,
// launch resolution, bootstrap publication and its strict consumer remain in the path.
vi.mock('@/configuration', async importOriginal => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual,
  configuration: { ...actual.configuration, get happyHomeDir() { return storage.home; },
    get settingsFile() { return join(storage.home, 'settings.json'); },
    get activeServerDir() { return join(storage.home, 'servers', 'active'); },
    get daemonStateFile() { return join(storage.home, 'daemon.state.json'); },
    get daemonLockFile() { return join(storage.home, 'daemon.lock'); },
    get logsDir() { return join(storage.home, 'logs'); },
    get serversDir() { return join(storage.home, 'servers'); },
    get privateKeyFile() { return join(storage.home, 'private-key.json'); },
    get legacyPrivateKeyFile() { return join(storage.home, 'legacy-private-key.json'); },
    get installationIdentityFile() { return join(storage.home, 'installation-identity.json'); },
    get deviceLocalSecretKeyFile() { return join(storage.home, 'device-local-secret-key.json'); },
    activeServerId: 'df38-home', serverUrl: 'http://df38.example.test',
    apiServerUrl: 'http://df38.example.test', publicServerUrl: 'http://df38.example.test',
    publicReleaseRing: 'stable' },
  };
});
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ ...storage.credentials, token: storage.persistedToken }),
  readSettings: async () => ({ machineId: 'df38-machine' }),
  readDaemonState: async () => storage.daemonPort ? { pid: process.pid, httpPort: storage.daemonPort,
    controlToken: storage.daemonControlToken, startedAt: 1, startedWithCliVersion: 'test' } : null,
}));

let runtime: Awaited<ReturnType<typeof createCustomAcpAdmissionRuntimeFixture>>;
let api: ApiClient;
let runtimeHome = '';
beforeAll(async () => {
  storage.home = await mkdtemp(join(tmpdir(), 'happier-df38-spawn-'));
  runtimeHome = storage.home;
  runtime = await createCustomAcpAdmissionRuntimeFixture();
  api = await ApiClient.create(storage.credentials);
});
afterAll(async () => {
  await runtime?.dispose();
  resetActiveAccountSettingsSnapshotForTests();
  await rm(runtimeHome, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(storage.home, { recursive: true, force: true });
  storage.home = runtimeHome;
});
beforeEach(async () => {
  // The fixture controller remains one real daemon occurrence, but each
  // process replay owns its own Home/markers, just as distinct workers do.
  storage.home = await mkdtemp(join(tmpdir(), 'happier-df42-runner-'));
  storage.persistedToken = storage.credentials.token;
  resetActiveAccountSettingsSnapshotForTests();
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
    scopeKey: resolveAccountSettingsScopeKey(storage.credentials), settingsVersion: 4,
    loadedAtMs: 1, settingsSecretsReadKeys: [],
    acpCatalog: { status: 'ready', revision: 4, record: AcpCatalogRecordV1Schema.parse({ v: 1,
      definitions: ['alpha', 'beta', 'missing'].map(id => ({ id, name: id, title: id,
        launch: { kind: 'command', command: id === 'missing' ? join(storage.home, 'missing-goose') : process.execPath, args: [`${id}.mjs`] },
        env: { DF38_SELECTION: { t: 'literal', v: id }, DF41_TARGET_KEY: { t: 'literal', v: buildBackendTargetKeyV2({
          kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: id }) } },
        capabilities: { supportsLoadSession: true, supportsModes: 'unknown', supportsModels: 'unknown',
          supportsConfigOptions: 'unknown', promptImageSupport: 'no' }, createdAt: 1, updatedAt: 2 })) }) } });
});

function params(definitionId: string, beforeSessionRunnerLaunch: () => Promise<boolean>): ExecuteSpawnSessionRequestParams {
  return { options: { directory: storage.home,
      agentTarget: AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId }),
      beforeSessionRunnerLaunch }, credentials: storage.credentials,
    api,
    connectedServicesMaterializationBaseDir: join(storage.home, 'connected-services'),
    connectedServiceRefreshCoordinator: null, connectedServiceQuotasCoordinator: null,
    connectedServiceRuntimeRegistry: { registerTarget: () => {} },
    pidToTrackedSession: new Map(), pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(), spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
    resolveCanonicalTrackedSessionId: () => '', onChildExited: () => {},
    processEnv: { ...process.env } };
}

function homeResponse<T>(data: T, status = 200): AxiosResponse<T> {
  return { data, status, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

describe('Custom ACP fresh daemon launch composition', () => {
  it('reads retained bundled Agent resources from the admitted development source root', async () => {
    const registration = [...runtime.registry.agentRuntimesByAgentId.values()]
      .find(value => value.pluginId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId);
    const binding = registration?.sessionRunnerFactoryBinding;
    const createServices = runtime.registry.createRetainedRunnerAgentInvocationServices;
    if (!binding || !createServices) throw new Error('Expected real admitted retained Agent services');
    const lifetime = new AbortController();
    try {
      const invocation = await createServices({ binding, sessionId: 'cdf41resources000000000001',
        correlationId: 'df41-retained-resource', cwd: storage.home, environment: {},
        providerBindingActive: false, signal: lifetime.signal, isOccurrenceCurrent: () => true });
      const resource = await invocation.services.resources.read('brand-icon');
      expect(resource).toMatchObject({ kind: 'asset', contentType: 'image/png' });
      expect(resource.bytes).toEqual(new Uint8Array(await readFile(new URL(
        '../../../../../packages/plugins/custom-acp/assets/brand.png', import.meta.url))));
    } finally {
      lifetime.abort();
    }
  });

  it.each([
    { definitionId: 'alpha', failure: null },
    { definitionId: 'beta', failure: null },
    { definitionId: 'alpha', failure: 'registry_miss' },
    { definitionId: 'alpha', failure: 'custody_mismatch' },
    { definitionId: 'alpha', failure: 'authority_refusal' },
  ] as const)('carries qualified $definitionId runner preparation through the real daemon route ($failure)', async ({ definitionId, failure }) => {
    const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('df41-child-exit'); });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug');
    const refusalLog = vi.spyOn(logger, 'warnLocalFile');
    const retainedServicesDescriptor = Object.getOwnPropertyDescriptor(runtime.registry, 'createRetainedRunnerAgentInvocationServices');
    const actualFetch = globalThis.fetch;
    const networkSpies: Array<{ mockRestore(): void }> = [];
    const daemonServiceDeliveries: Array<{ request: ReturnType<typeof AgentRuntimeDaemonServiceRequestV1Schema.parse>;
      response: ReturnType<typeof AgentRuntimeDaemonServiceResponseV1Schema.parse> }> = [];
    let daemon: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | undefined;
    const daemonMutationCustody = createDaemonSessionMutationCustody({ credentials: storage.credentials });
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Expected the admitted fixture Account');
    const rawSettings = { ...snapshot.settings };
    setActiveAccountSettingsSnapshot({ ...snapshot, rawSettings, loadedAtMs: Date.now(),
      settings: accountSettingsParse(rawSettings),
      mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [],
        catalog: McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] }) },
      promptLibraryCatalog: { status: 'ready', rows: PromptLibraryCatalogKeyV1Schema.options
        .map(key => ({ record: emptyPromptLibraryRecordV1(key, 1), revision: 1 })), tombstones: [], diagnostics: [] } });
    const initialProcessOwner = process.env[PROCESS_OWNER_ENV_KEY];
    const daemonEnvironment = { ...process.env, HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto' };
    vi.stubEnv(PROCESS_OWNER_ENV_KEY, initialProcessOwner);
    storage.runnerCommand = `${process.execPath} ${join(process.cwd(), 'src', 'index.ts')}`;
    // The managed Linux launch has an OS wrapper and a distinct Session runner.
    // Model those process identities at the OS boundary instead of making the
    // worker stand in for both roles, which skips canonical child adoption.
    storage.runnerWrapperPid = process.pid + 1_000_000;
    storage.sourceChecks = [];
    storage.runnerLaunches = [];
    let sessionId = 'cdf41qualified000000000001';
    let sessionRow: V2SessionByIdResponse['session'] = createSessionNotificationContextFixture(sessionId);
    const trackedSessions = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver: ExecuteSpawnSessionRequestParams['pidToSpawnResultResolver'] = new Map();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const spawnResourceCleanupByPid: ExecuteSpawnSessionRequestParams['spawnResourceCleanupByPid'] = new Map();
    const sessionAttachCleanupByPid: ExecuteSpawnSessionRequestParams['sessionAttachCleanupByPid'] = new Map();
    const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
    const onChildExited = createOnChildExited({ pidToTrackedSession: trackedSessions, spawnResourceCleanupByPid,
      sessionAttachCleanupByPid, getApiMachineForSessions: () => null });
    const onHappySessionWebhook = createOnHappySessionWebhook({ pidToTrackedSession: trackedSessions, pidToAwaiter,
      spawnResourceCleanupByPid, sessionAttachCleanupByPid, deviceLocalSecretStorage,
      getParentPidFn: pid => pid === process.pid ? storage.runnerWrapperPid : null });
    let child: ChildProcess | undefined;
    const actualKill = process.kill;
    networkSpies.push(vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (storage.runnerCommand && (Math.abs(pid) === process.pid || Math.abs(pid) === storage.runnerWrapperPid)) {
        if (signal !== 0) throw new Error('A synthetic runner must never signal the Vitest worker');
        if (pid < 0 || storage.runnerExited) throw Object.assign(new Error('Synthetic runner is absent'), { code: 'ESRCH' });
        return true;
      }
      return actualKill(pid, signal);
    }));
    const terminateActualProcess = processTermination.terminateProcessTree;
    networkSpies.push(vi.spyOn(processTermination, 'terminateProcessTree').mockImplementation(async (processToStop, options) => {
      if (processToStop !== child) return await terminateActualProcess(processToStop, options);
      storage.runnerExited = true;
      child?.emit('exit', 0, null);
    }));
    const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } }, capabilities: {
      accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2,
        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1' },
      encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
      session: { runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 } },
    } });
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'df38-machine' });
    const transcript = createSessionTranscriptHomeStub();
    const socket = createApiSessionSocketStub({ connected: true,
      emitWithAck: (event, payload) => activity.answer(event, payload) ?? transcript.answer(event, payload) ?? { ok: true, result: 'success',
        version: 1, id: 'df41-message', seq: 1, localId: 'df41-message' },
      emit: (event, args) => {
        const callback = args.at(-1);
        if (typeof callback === 'function') callback(activity.answer(event, args[0]) ?? transcript.answer(event, args[0]) ?? { ok: true, result: 'success', version: 1 });
      } });
    storage.io.mockImplementation(() => socket);
    try {
      // Home HTTP/Socket.IO are external boundaries. Session construction,
      // metadata/privacy serialization, authority, installed command, native
      // Agent factory and ACP transport all execute their production owners.
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
          const serviceRequest = typeof init?.body === 'string'
            ? AgentRuntimeDaemonServiceRequestV1Schema.safeParse(JSON.parse(init.body)) : null;
          if (serviceRequest?.success && serviceRequest.data.operation.kind === 'plugin_services.prepare_v1') {
            // Force actual owner inputs/registry wiring, never substitute its
            // preparation, authority, custody verifier or refusal implementation.
            if (failure === 'registry_miss') {
              Reflect.deleteProperty(runtime.registry, 'createRetainedRunnerAgentInvocationServices');
            } else if (failure === 'custody_mismatch') {
              const tracked = [...trackedSessions.values()].find(value => value.happySessionId === sessionId);
              const authorityPath = tracked?.agentRuntimeDaemonServiceAuthorityFilePath;
              if (!authorityPath) throw new Error('Expected the produced private runner authority');
              const authority = JSON.parse(await readFile(authorityPath, 'utf8'));
              // The real HTTP reader consumes a retained binding whose version
              // no longer matches its actual source manifest. The original
              // capability, process identity and source custody remain exact.
              authority.retainedAgent.pluginVersion = 'df43-unavailable-version';
              await writeFile(authorityPath, JSON.stringify(authority), 'utf8');
            } else if (failure === 'authority_refusal') {
              const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ ...serviceRequest.data,
                operation: { ...serviceRequest.data.operation, witness: { turnId: 'df43-unadmitted-turn',
                  inputId: 'df43-unadmitted-input', userMessageSeq: null, userMessageSeqs: [] } } });
              init = { ...init, body: JSON.stringify(request) };
            }
          }
          const response = await actualFetch(input, init);
          if (response.ok && serviceRequest?.success && serviceRequest.data.operation.kind === 'plugin_services.prepare_v1') {
            daemonServiceDeliveries.push({ request: serviceRequest.data,
              response: AgentRuntimeDaemonServiceResponseV1Schema.parse(await response.clone().json()) });
          }
          return response;
        }
        if (url.pathname.startsWith('/v1/features')) return Response.json(features);
        return new Response('{}', { status: 404 });
      }));
      networkSpies.push(vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/auth/ping') return homeResponse({ ok: true });
        if (path === '/v1/account/encryption/currentness') return homeResponse(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
        if (path === `/v2/sessions/${sessionId}`) return homeResponse(V2SessionByIdResponseSchema.parse({ session: sessionRow }));
        if (path.startsWith('/v1/access-keys/')) return homeResponse({ accessKey: 'df41-machine-control' });
        if (path === '/v1/artifacts') return homeResponse([]);
        if (path.endsWith('/messages')) return homeResponse({ messages: [], hasMore: false });
        throw new Error(`Unexpected Home GET ${path}`);
      }));
      networkSpies.push(vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
        const parsedUrl = new URL(String(url));
        if (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost') {
          const headers = new Headers();
          for (const [key, value] of Object.entries(AxiosHeaders.from(config?.headers).toJSON())) {
            if (value !== undefined && value !== null && value !== false) headers.set(key, String(value));
          }
          if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
          const signal = config?.signal;
          if (signal && !(signal instanceof AbortSignal)) throw new Error('Expected an AbortSignal at the HTTP boundary');
          const response = await actualFetch(String(url), { method: 'POST', headers, body: JSON.stringify(body), signal });
          return homeResponse(await response.json(), response.status);
        }
        if (parsedUrl.pathname === '/v1/sessions') {
          if (!body || typeof body !== 'object') throw new Error('Invalid Session create body');
          const sharedMetadata = 'sharedMetadata' in body ? body.sharedMetadata : null;
          if (!sharedMetadata || typeof sharedMetadata !== 'object' || !('ciphertext' in sharedMetadata)
            || typeof sharedMetadata.ciphertext !== 'string') throw new Error('Missing produced shared metadata');
          const ownerMetadata = StoredSessionOwnerMetadataEnvelopeV1Schema.parse('ownerMetadata' in body ? body.ownerMetadata : undefined);
          if (ownerMetadata.t !== 'plain') throw new Error('Expected the plain fixture Account');
          StoredSessionSharedMetadataV1Schema.parse(JSON.parse(sharedMetadata.ciphertext));
          const agentState = 'agentState' in body ? body.agentState : undefined;
          if (typeof agentState !== 'string' && agentState !== null) throw new Error('Invalid produced Agent state');
          if (!('metadataLayoutVersion' in body) || body.metadataLayoutVersion !== 1
            || !('encryptionMode' in body) || body.encryptionMode !== 'plain') throw new Error('Expected plain privacy-layout creation');
          sessionRow = V2SessionByIdResponseSchema.parse({ session: { ...sessionRow, id: sessionId,
            encryptionMode: body.encryptionMode, metadataLayoutVersion: body.metadataLayoutVersion,
            share: null, ownerMetadata, agentState, metadata: sharedMetadata.ciphertext } }).session;
          return homeResponse({ session: sessionRow, created: true, organizationPlacement: { folderId: null, tagIds: [] } });
        }
        if (parsedUrl.pathname.endsWith('/access-key')) return homeResponse({ success: true });
        throw new Error(`Unexpected Home POST ${parsedUrl.pathname}`);
      }));
      networkSpies.push(vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
        if (new URL(String(url)).pathname !== `/v2/sessions/${sessionId}`) throw new Error('Unexpected Home PATCH');
        const patch = SessionMetadataTuplePatchV1Schema.parse(body);
        if (patch.mode !== 'owner') throw new Error('Expected the ordinary owner metadata tuple');
        sessionRow = V2SessionByIdResponseSchema.parse({ session: { ...sessionRow, metadataLayoutVersion: patch.metadataLayoutVersion,
          metadata: patch.sharedMetadata.ciphertext, metadataVersion: patch.sharedMetadata.expectedVersion + 1,
          ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext,
          agentStateVersion: patch.agentState.expectedVersion + 1 } }).session;
        return homeResponse(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
          sharedMetadata: { version: sessionRow.metadataVersion }, agentState: { version: sessionRow.agentStateVersion } }));
      }));
      daemon = await startDaemonSessionControlRuntime({ machineId: 'df38-machine', serverId: 'df38-home',
        serverBaseUrl: configuration.serverUrl, credentials: storage.credentials, api,
        daemonSessionMutationCustody: daemonMutationCustody,
        connectedServicesMaterializationBaseDir: join(storage.home, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        pidToTrackedSession: trackedSessions, pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout,
        getApiMachineForSessions: () => null, spawnResourceCleanupByPid, sessionAttachCleanupByPid,
        deviceLocalSecretStorage,
        connectedServicesRestartRequestedPids: new Set(), beforeShutdown: async () => {},
        onHappySessionWebhook, requestShutdown: () => {}, processEnv: {} });
      storage.daemonPort = daemon.controlPort;
      storage.daemonControlToken = daemon.controlToken;
      {
        sessionId = definitionId === 'alpha' ? 'cdf41qualified00000000000a' : 'cdf41qualified00000000000b';
        sessionRow = createSessionNotificationContextFixture(sessionId);
        vi.unstubAllEnvs();
        vi.stubEnv(PROCESS_OWNER_ENV_KEY, initialProcessOwner);
        storage.runnerExited = false;
        const observedPath = join(storage.home, `${definitionId}-first-model.json`);
        const script = writeAcpTestAgentScript({ dir: storage.home, fileName: `${definitionId}.mjs`, source: `
          import { writeFileSync } from 'node:fs';
          let buffer = '';
          process.stdin.on('data', chunk => {
            buffer += chunk;
            const lines = buffer.split('\\n'); buffer = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              const request = JSON.parse(line);
              if (request.method === 'session/set_model') {
                writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ definitionId: process.env.DF38_SELECTION,
                  agentTargetKey: process.env.DF41_TARGET_KEY, pid: process.pid, request }));
                process.exit(0);
              }
              const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }
                : request.method === 'session/new' ? { sessionId: 'df41-vendor', models: { currentModelId: 'other', availableModels: [{ modelId: 'ollama/qwen2.5:3b', name: 'Qwen' }] } }
                : {};
              if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
            }
          });
        ` });
        expect(script).toBe(join(storage.home, `${definitionId}.mjs`));
        let runnerFailure: unknown;
        let runnerCompletion: Promise<void> | undefined;
        storage.runnerSpawn = (args, environment) => {
          // The OS adapter runs the child in this worker. All argv, environment,
          // tracked registration, markers and private authority come from the
          // production spawn and webhook producers, never a fixture reassembly.
          child = new ChildProcess();
          Object.defineProperty(child, 'pid', { value: storage.runnerWrapperPid });
          child.kill = () => true;
          runnerCompletion = Promise.resolve().then(async () => {
            try {
              const tracked = trackedSessions.get(storage.runnerWrapperPid);
              if (!tracked || (tracked.acceptedSpawnMarkerGate && !await tracked.acceptedSpawnMarkerGate)) {
                throw new Error('Real spawn marker was not accepted');
              }
              for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
              const command = args[0];
              if (!command) throw new Error('Real spawn produced no Agent command');
              const handler = await requireCatalogEntry(command).getCliCommandHandler!();
              fatal.mockClear();
              await expect(handler({ args, rawArgv: ['happier', ...args], terminalRuntime: null })).rejects.toThrow('df41-child-exit');
              runnerFailure = fatal.mock.calls.at(-1)?.[0];
            } catch (error) {
              runnerFailure = error;
            } finally {
              storage.runnerExited = true;
              child?.emit('exit', 0, null);
            }
          });
          return child;
        };
        const spawnInput = params(definitionId, async () => {
          const bootstrapDir = join(storage.home, 'tmp', 'runner-agent-session-bootstraps');
          const files = await readdir(bootstrapDir);
          expect(files).toHaveLength(1);
          storage.runnerBootstrapPath = join(bootstrapDir, files[0]!);
          const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(storage.runnerBootstrapPath, 'utf8')));
          expect(bootstrap.launch?.runtimeDescriptorV1.agent.definitionId).toBe(definitionId);
          return true;
        });
        // Fresh daemon startup is correlated by the request's existing nonce;
        // the real marker owner requires it when adopting a PID placeholder.
        spawnInput.options.spawnNonce = `df41-${definitionId}-launch`;
        // The Home-issued birth authorization makes the real daemon create
        // owner commit the Session before the wrapped runner attaches to it.
        spawnInput.options.creationAuthorization = { token: 'df42-home-create-authorization' };
        // Restricted runners deliberately cannot read hosting Account defaults.
        // The public spawn request carries the user's admitted permission intent.
        spawnInput.options.permissionMode = definitionId === 'alpha' ? 'read-only' : 'yolo';
        spawnInput.options.modelSelection = SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1, ref: {
          agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId }),
          providerConnectionId: null, modelId: 'ollama/qwen2.5:3b' } });
        const result = await executeSpawnSessionRequest({ ...spawnInput, pidToTrackedSession: trackedSessions, pidToAwaiter,
          pidToSpawnResultResolver, pidToSpawnWebhookTimeout, spawnResourceCleanupByPid, sessionAttachCleanupByPid,
          deviceLocalSecretStorage, onChildExited, processEnv: daemonEnvironment,
          resolveCanonicalTrackedSessionId: pid => trackedSessions.get(pid)?.happySessionId ?? '' });
        await runnerCompletion;
        storage.runnerSpawn = null;
        const observed = await readFile(observedPath, 'utf8').catch(() => null);
        if (failure) {
          const cause = failure === 'registry_miss'
            ? { code: 'plugin_services_retained_generation_unavailable', stage: 'retained_agent_services' }
            : failure === 'custody_mismatch'
              ? { code: 'plugin_services_retained_managed_dependency_unavailable', stage: 'retained_agent_services' }
              : { code: 'plugin_services_turn_authority_unavailable', stage: 'turn_authority' };
          expect(daemonServiceDeliveries, 'The refusal must traverse the strict real HTTP consumer').toHaveLength(1);
          expect(daemonServiceDeliveries[0]?.response).toEqual({ ok: false, error: {
            code: cause.code, message: `Runner PluginServices preparation failed (${cause.stage}: ${cause.code})`, cause } });
          expect(runnerFailure).toMatchObject({ name: 'PluginError', code: cause.code, details: { cause } });
          expect(refusalLog.mock.calls.filter(([message]) => message.includes('runner_plugin_services_prepare_refused')))
            .toEqual([[JSON.stringify({ kind: 'runner_plugin_services_prepare_refused', cause })]]);
          expect(observed, 'A refused preparation must not start the vendor model operation').toBeNull();
          return;
        }
        const snapshotFailure = debug.mock.calls.filter(([message]) => String(message).includes('Failed to sync session snapshot')).at(-1);
        expect(observed, `Spawn result: ${JSON.stringify(result)}\nOwn OS launch: ${JSON.stringify(storage.runnerLaunches)}\nRunner failed before native model call: ${runnerFailure instanceof Error
          ? runnerFailure.stack : String(runnerFailure)}\nRunner cause code: ${runnerFailure && typeof runnerFailure === 'object'
            ? String(Reflect.get(runnerFailure, 'code')) : 'none'}\nSnapshot transport: ${JSON.stringify(snapshotFailure?.slice(1))}\nSpawn boundary: ${JSON.stringify(debug.mock.calls
              .filter(([message]) => String(message).includes('preflight') || String(message).includes('Failed to spawn')
                || String(message).includes('Canonical Session startup readiness failed')
                || String(message).includes('Canonical adoption ownership mismatch')).slice(-3)
              .map(([message, cause]) => [message, cause instanceof Error ? cause.stack : cause]))}`).not.toBeNull();
        const prepared = daemonServiceDeliveries.filter(({ request }) => request.context.sessionId === sessionId);
        expect(prepared, 'Installed runner must prepare PluginServices through the real daemon loopback route').not.toHaveLength(0);
        expect(prepared.map(({ response }) => response)).toEqual(expect.arrayContaining([
          expect.objectContaining({ ok: true, result: expect.objectContaining({ kind: 'plugin_services.result_v1' }) }),
        ]));
        expect(result).toMatchObject({ type: 'success', sessionId });
        for (const sourceCheck of storage.sourceChecks ?? []) {
          expect(sourceCheck).toEqual({ command: process.execPath,
            args: [join(process.cwd(), 'scripts', 'syncSharedDepsForDev.mjs'), '--check'] });
        }
        const admittedTarget = AgentExecutionTargetV1Schema.parse({ kind: 'agent',
          identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId });
        // ACP itself transports a native model id, not host Agent identity.
        // The real selected definition's environment qualifies the physical
        // vendor process receiving that first model request.
        const firstModel = JSON.parse(observed!);
        expect(firstModel).toMatchObject({ definitionId, agentTargetKey: buildBackendTargetKeyV2(admittedTarget), request: {
          method: 'session/set_model', params: { modelId: 'ollama/qwen2.5:3b' } } });
        const ownerMetadata = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(sessionRow.ownerMetadata);
        if (ownerMetadata.t !== 'plain') throw new Error('Expected the plain produced owner metadata');
        const producedMetadata = projectSessionOwnerCompatibilityViewV1({
          sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(sessionRow.metadata!)),
          ownerMetadata: ownerMetadata.v });
        expect(readPermissionModeIntentFromMetadata(producedMetadata), 'Session startup must preserve the admitted permission intent')
          .toMatchObject({ permissionMode: definitionId === 'alpha' ? 'read-only' : 'yolo' });
        expect(Number.isSafeInteger(firstModel.pid) && firstModel.pid > 0).toBe(true);
        expect(await readProcessIdentityByPid(firstModel.pid), 'The real owned ACP vendor process must be retired').toBeNull();
        expect(storage.runnerExited, 'The owned in-process runner must be retired').toBe(true);
      }
    } finally {
      if (retainedServicesDescriptor) Object.defineProperty(runtime.registry, 'createRetainedRunnerAgentInvocationServices', retainedServicesDescriptor);
      await daemon?.stopControlServer();
      await daemonMutationCustody.close();
      for (const spy of networkSpies.reverse()) spy.mockRestore();
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
      storage.runnerCommand = ''; storage.runnerExited = false; storage.sourceChecks = null;
      storage.runnerWrapperPid = 0;
      storage.runnerSpawn = null;
      storage.runnerBootstrapPath = '';
      storage.daemonPort = 0; storage.daemonControlToken = '';
      fatal.mockRestore(); exit.mockRestore(); stderr.mockRestore(); debug.mockRestore(); refusalLog.mockRestore();
    }
  }, 180_000);

  it('carries the admitted bootstrap through the real catalog runner into strict model ingress', async () => {
    // Process exit and file logging are OS boundaries. No runner, catalog,
    // model resolver or host runtime is replaced. Absent daemon authority
    // stops this in-process child before a real vendor process can start.
    const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('df40-child-exit'); });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const definitionId of ['alpha', 'beta']) {
        let enteredRunner = false;
        const failures: Array<Readonly<{ modelDefinition: string; error: unknown }>> = [];
        const result = await executeSpawnSessionRequest(params(definitionId, async () => {
          const bootstrapDir = join(configuration.happyHomeDir, 'tmp', 'runner-agent-session-bootstraps');
          const [file] = await readdir(bootstrapDir);
          const bootstrapPath = join(bootstrapDir, file!);
          const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(bootstrapPath, 'utf8')));
          const target = AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId });
          const backendTarget = projectResolvedAgentBackendTarget(target, bootstrap.descriptor.agentId);
          const command = resolveDaemonCliSubcommandFromBackendTarget(backendTarget)!;
          const handler = await requireCatalogEntry(command).getCliCommandHandler!();
          vi.stubEnv(HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY, bootstrapPath);
          vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, '');
          for (const modelDefinition of [definitionId, 'wrong-definition']) {
            fatal.mockClear();
            const selection = SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1,
              ref: { agentTargetKey: `agent:happier.agent.custom-acp/custom-acp:definition:${modelDefinition}`,
                providerConnectionId: null, modelId: 'ollama/qwen2.5:3b' } });
            const args = [command, '--started-by', 'daemon', ...buildHappySessionControlArgs({ backendTarget, modelSelection: selection })];
            await expect(handler({ args, rawArgv: ['happier', ...args], terminalRuntime: null })).rejects.toThrow('df40-child-exit');
            failures.push({ modelDefinition, error: fatal.mock.calls.at(-1)?.[0] });
          }
          enteredRunner = true;
          return false;
        }));
        expect({ enteredRunner, result }, JSON.stringify(result)).toMatchObject({ enteredRunner: true,
          result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
        expect(failures[0]?.error).toMatchObject({ code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING' });
        expect(failures[1]?.error).toMatchObject({ code: 'model_selection_agent_target_mismatch' });
      }
    } finally {
      vi.unstubAllEnvs();
      fatal.mockRestore();
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  it('carries each qualified definition through execution surfaces and bootstrap into its exact spawn specification', async () => {
    for (const definitionId of ['alpha', 'beta']) {
      let reachedLaunch = false;
      const result = await executeSpawnSessionRequest(params(definitionId, async () => {
        const bootstrapDir = join(configuration.happyHomeDir, 'tmp', 'runner-agent-session-bootstraps');
        const files = await readdir(bootstrapDir);
        expect(files).toHaveLength(1);
        const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(join(bootstrapDir, files[0]!), 'utf8')));
        const descriptor = RuntimeDescriptorV1Schema.parse(bootstrap.launch?.runtimeDescriptorV1);
        expect(descriptor.agent.definitionId).toBe(definitionId);
        const selectedTarget = AgentExecutionTargetV1Schema.parse({ kind: 'agent',
          identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId });
        expect(await resolveTrackedSessionTerminalPresentation({ startedBy: 'daemon', pid: process.pid,
          spawnOptions: { directory: storage.home, agentTarget: selectedTarget,
            backendTarget: projectResolvedAgentBackendTarget(selectedTarget, descriptor.agentId),
            runtimeDescriptorV1: descriptor } }, 'plain')).toEqual({ kind: 'none' });
        const launch = await resolveAccountConfiguredAcpLaunchForAgent({ identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
          startupRuntimeDescriptorV1: descriptor });
        expect(await launch?.resolveHostLaunch({ cwd: storage.home })).toMatchObject({
          command: process.execPath, args: [`${definitionId}.mjs`], env: { DF38_SELECTION: definitionId } });
        reachedLaunch = true;
        // The production pre-launch custody hook refuses physical execution;
        // the test observes the real spec without launching another daemon.
        return false;
      }));
      expect({ reachedLaunch, result }, JSON.stringify(result)).toMatchObject({ reachedLaunch: true,
        result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
    }
  });

  it('retains a thrown typed launch cause instead of an opaque spawn failure', async () => {
    const result = await executeSpawnSessionRequest(params('alpha', async () => {
      throw Object.assign(new Error('Launch permission refused'), { code: 'EACCES' });
    }));
    expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
      errorDetail: { kind: 'launch_error', code: 'EACCES', message: 'Launch permission refused' } });
    if (result.type !== 'error') throw new Error('Expected a launch failure');
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(result));
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }))).toMatchObject({ code: 'spawn_failed', launchError: { code: 'EACCES', message: 'Launch permission refused' } });
  });

  it('refuses a missing selected executable with the Agent-not-installed code before runner launch', async () => {
    const result = await executeSpawnSessionRequest(params('missing', async () => {
      throw new Error('A missing executable must never reach runner admission');
    }));
    expect(result, JSON.stringify(result)).toMatchObject({ type: 'error', errorCode: 'agent_cli_missing', agentId: 'custom-acp' });
  });

  it('supplies a cause code for an unexpected uncoded launch failure', async () => {
    const result = await executeSpawnSessionRequest(params('alpha', async () => { throw new Error('Unexpected launch failure'); }));
    expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
      errorDetail: { kind: 'launch_error', code: 'SPAWN_FAILED', message: 'Unexpected launch failure' } });
  });

  it('preserves the actual Account ACP launch-resolution refusal code', async () => {
    storage.persistedToken = 'foreign-account-token';
    const result = await executeSpawnSessionRequest(params('alpha', async () => {
      throw new Error('Unavailable Account launch custody must not reach runner admission');
    }));
    expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
      errorDetail: { kind: 'launch_error', code: 'ACP_CATALOG_UNAVAILABLE', message: expect.stringContaining('credentials-unavailable') } });
  });

  it('validates the selected command on the supplied launch PATH', async () => {
    const bin = await mkdtemp(join(storage.home, 'bin-'));
    const command = 'df38-path-only-agent';
    await writeExecutableShim({ dir: bin, fileName: command,
      contents: process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n' });
    const snapshot = getActiveAccountSettingsSnapshot()!;
    if (snapshot.acpCatalog?.status !== 'ready') throw new Error('Expected the ready launch catalog');
    commitActiveAcpCatalog({ scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { ...snapshot.acpCatalog, revision: 5, record: AcpCatalogRecordV1Schema.parse({ v: 1,
        definitions: snapshot.acpCatalog.record.definitions.map(definition => definition.id === 'alpha'
          ? { ...definition, launch: { kind: 'command', command, args: [] } } : definition) }) } });
    let reached = false;
    const input = params('alpha', async () => { reached = true; return false; });
    const result = await executeSpawnSessionRequest({ ...input,
      processEnv: { ...input.processEnv, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` } });
    expect({ reached, result }, JSON.stringify(result)).toMatchObject({ reached: true,
      result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
  });

  it('validates a relative configured command from the Session directory', async () => {
    const command = 'df38-relative-agent';
    await writeExecutableShim({ dir: storage.home, fileName: command,
      contents: process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n' });
    const snapshot = getActiveAccountSettingsSnapshot()!;
    if (snapshot.acpCatalog?.status !== 'ready') throw new Error('Expected the ready launch catalog');
    commitActiveAcpCatalog({ scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { ...snapshot.acpCatalog, revision: 5, record: AcpCatalogRecordV1Schema.parse({ v: 1,
        definitions: snapshot.acpCatalog.record.definitions.map(definition => definition.id === 'alpha'
          ? { ...definition, launch: { kind: 'command', command: `./${command}`, args: [] } } : definition) }) } });
    let reached = false;
    const result = await executeSpawnSessionRequest(params('alpha', async () => { reached = true; return false; }));
    expect({ reached, result }, JSON.stringify(result)).toMatchObject({ reached: true,
      result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
  });

  it('refuses a selected command whose required JavaScript runtime cannot resolve', async () => {
    const command = await writeExecutableShim({ dir: storage.home, fileName: 'df40-node-agent',
      contents: '#!/usr/bin/env node\nprocess.exit(0);\n' });
    const snapshot = getActiveAccountSettingsSnapshot()!;
    if (snapshot.acpCatalog?.status !== 'ready') throw new Error('Expected the ready launch catalog');
    commitActiveAcpCatalog({ scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { ...snapshot.acpCatalog, revision: 5, record: AcpCatalogRecordV1Schema.parse({ v: 1,
        definitions: snapshot.acpCatalog.record.definitions.map(definition => definition.id === 'alpha'
          ? { ...definition, launch: { kind: 'command', command, args: [] } } : definition) }) } });
    let reachedRunner = false;
    const input = params('alpha', async () => { reachedRunner = true; return false; });
    // An explicit invalid runtime override is exclusive at the real managed
    // JavaScript resolver. A present vendor script alone is not launchability.
    const result = await executeSpawnSessionRequest({ ...input,
      processEnv: { ...input.processEnv, HAPPIER_JS_RUNTIME_PATH: 'df40-unresolved-runtime' } });
    expect({ reachedRunner, result }, JSON.stringify(result)).toMatchObject({ reachedRunner: false,
      result: { type: 'error', errorCode: 'agent_cli_missing', agentId: 'custom-acp' } });
  });
});
