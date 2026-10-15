import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { configuration, reloadConfiguration } from '@/configuration';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ApiClient } from '@/api/api';
import { registerSessionClientRuntimeHandlers } from '@/api/session/client/executionRuns/registerSessionClientRuntimeHandlers';
import { applySessionRuntimeControls } from '@/api/session/sessionRuntimeControls';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { createRunnerExecutionRunSnapshotResolver } from '@/agent/runtime/session/process/runnerExecutionRunSnapshot';
import type { RunnerExecutionRunSnapshotV1 } from '@/agent/runtime/session/process/executionRunSnapshotProtocol';
import type { TrackedSession } from '@/daemon/types';
import { writeDaemonState } from '@/persistence';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createSessionRunSnapshotFixture, createSnapshotSessionPendingTransport } from './sessionRunnerSnapshot.fixture';
import { deriveConnectedServiceRunMaterializeToken } from '@/daemon/connectedServices/runs/capabilityToken';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { normalizeExecutionRunRpcPayload } from '@/session/services/executionRuns';
import type { NativeAgentSessionInteractionHostBinding, NativeAgentSessionRunToolBindingRequest } from '@/agent/runtime/registry/engineRegistryTypes';

const transport = vi.hoisted(() => ({ app: null as unknown }));
// Only HTTP listener/transport is substituted. Real daemon composition, ingress,
// tracked-runner authorization, source custody and native child requests remain.
vi.mock('@/daemon/controlServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof actual.startDaemonControlServer>[0]) => {
    const app = actual.createDaemonControlApp(input);
    transport.app = app;
    return { port: 46021, stop: async () => { await app.close(); transport.app = null; } };
  } };
});

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
let originalProcessTitle: string | undefined;
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (originalProcessTitle !== undefined) { process.title = originalProcessTitle; originalProcessTitle = undefined; }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  if (failures.length > 0) throw failures[0];
});

it('admits Session-hosted Runs through tracked daemon HTTP and current MCP occurrence wiring, releasing custody at cleanup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-session-run-snapshot-'));
  roots.push(home);
  vi.stubEnv('HAPPIER_HOME_DIR', home);
  vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
  vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'execution.runs');
  vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
  reloadConfiguration();
  // The isolated test worker is the tracked runner subject. Exercise real OS
  // identity observation and the existing entrypoint parser without mocking them.
  originalProcessTitle = process.title;
  process.title = join(home, 'src', 'index.ts');
  expect(pluginReloadController.getState().activeRegistry).toBeNull();
  const fixture = await createSessionRunSnapshotFixture(home);
  cleanups.push(async () => await fixture.dispose());
  // Local tracked fixture has no Home terminal transport; use its supported
  // PID identity so exit does not fabricate server terminal-settlement custody.
  const sessionId = `PID-${process.pid}`;
  const backendTarget = { kind: 'backend' as const, backendId: 'acme.snapshot/parent' };
  const childTarget = { kind: 'backend' as const, backendId: 'acme.snapshot/child' };
  const parentRegistration = fixture.registry.agentRuntimesByAgentId.get(backendTarget.backendId);
  const parentBinding = parentRegistration?.hasPrimaryRuntime ? parentRegistration.sessionRunnerFactoryBinding : null;
  if (!parentBinding) {
    const diagnostics = fixture.registry.pluginDiagnosticsByPluginId['acme.snapshot'];
    await fixture.dispose();
    throw new Error('The admitted fixture has no parent source binding: ' + JSON.stringify(diagnostics));
  }
  const processIdentity = await readProcessIdentityByPid(process.pid);
  if (!processIdentity?.processStartTimeMs) throw new Error('Runner process identity unavailable');
  const entrypoint = resolveSessionRunnerEntrypointIdentityFromProcessCommand(processIdentity.command);
  if (entrypoint.status !== 'known') throw new Error('Test worker entrypoint identity unavailable');
  const runner = { pid: process.pid, processStartTimeMs: processIdentity.processStartTimeMs,
    processCommandHash: hashProcessCommand(processIdentity.command), snapshotIdentity: entrypoint.comparableId };
  const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: home,
    publicReleaseRing: configuration.publicReleaseRing });
  const issued = await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: home,
    publicReleaseRing: configuration.publicReleaseRing, path: authorityPath, sessionId, runner,
    retainedAgent: parentBinding, httpPort: 46021 });
  vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, authorityPath);
  const launcherPid = process.ppid;
  const tracked: TrackedSession = { pid: launcherPid, sessionRunnerPid: process.pid, startedBy: 'daemon', happySessionId: sessionId,
    processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
    runnerProcessIdentity: { pid: process.pid, processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash },
    runnerAgentSourceCustodyV1: parentBinding.sourceCustody,
    runnerAgentInvocationContext: { cwd: home, environment: {}, providerBindingActive: false },
    agentRuntimeDaemonServiceAuthorityFilePath: authorityPath, agentRuntimeDaemonServiceCapabilityHash: issued.capabilityDigest };
  const token = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from('{"sub":"snapshot-account"}').toString('base64url') + '.';
  const credentials = { token, encryption: null } as const;
  const settingsResponse = AccountSettingsV2GetResponseSchema.parse({ version: 1, content: { t: 'plain', v: {} } });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/account/settings') return { status: 200, data: settingsResponse };
    if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: { status: 'absent' } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({
      status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
        content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) }) };
    if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    throw new Error('Unexpected Home HTTP read: ' + path);
  });
  const trackedSessions = new Map([[launcherPid, tracked]]);
  const daemon = await startDaemonSessionControlRuntime({ machineId: 'snapshot-machine', serverId: configuration.activeServerId,
    serverBaseUrl: configuration.apiServerUrl, credentials, api: await ApiClient.create(credentials),
    pluginRuntimeController: fixture.controller,
    daemonSessionMutationCustody: { stageTranscriptMessage: async () => ({ persisted: true, delivered: true }),
      stageTranscriptEvent: async () => ({ persisted: true, delivered: true }) },
    connectedServicesMaterializationBaseDir: join(home, 'connected-services'),
    getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
    pidToTrackedSession: trackedSessions, pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(), getApiMachineForSessions: () => null, spawnResourceCleanupByPid: new Map(),
    sessionAttachCleanupByPid: new Map(), connectedServicesRestartRequestedPids: new Set(),
    beforeShutdown: async () => {}, onHappySessionWebhook: async () => {}, requestShutdown: () => {}, processEnv: {},
  });
  cleanups.push(async () => await daemon.stopControlServer());
  writeDaemonState({ pid: process.pid, httpPort: daemon.controlPort, controlToken: daemon.controlToken,
    startedAt: Date.now(), startedWithCliVersion: '0.0.0' });
  const daemonRequests: ReturnType<typeof AgentRuntimeDaemonServiceRequestV1Schema.parse>[] = [];
  const snapshots: RunnerExecutionRunSnapshotV1[] = [];
  let replaceAuthorityAfterAcquisition = false;
  const actualFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== '127.0.0.1' || Number(url.port) !== daemon.controlPort) return actualFetch(input, init);
    const app = transport.app as ReturnType<typeof import('@/daemon/controlServer').createDaemonControlApp> | null;
    if (!app) throw new Error('Missing daemon HTTP composition');
    if (url.pathname === '/agent-runtime/session/services/v1')
      daemonRequests.push(AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body))));
    const reply = await app.inject({ method: 'POST', url: url.pathname,
      headers: Object.fromEntries(new Headers(init?.headers)), payload: String(init?.body ?? '{}') });
    if (url.pathname === '/agent-runtime/session/services/v1') {
      const response = AgentRuntimeDaemonServiceResponseV1Schema.parse(reply.json());
      if (response.ok && response.result.kind === 'execution_run.snapshot') {
        snapshots.push(response.result);
        expect(AgentRuntimeDaemonServiceResponseV1Schema.safeParse({ ...response,
          result: { ...response.result, unexpected: true } }).success).toBe(false);
        if (replaceAuthorityAfterAcquisition) {
          replaceAuthorityAfterAcquisition = false;
          await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: home,
            publicReleaseRing: configuration.publicReleaseRing, path: authorityPath,
            sessionId, runner, retainedAgent: parentBinding, httpPort: daemon.controlPort });
        }
      }
    }
    return new Response(reply.body, { status: reply.statusCode, headers: { 'content-type': 'application/json' } });
  });
  const metadata = createTestMetadata({ runtimeDescriptorV1: { v: 1, agentId: backendTarget.backendId, agent: {} },
    path: home, machineId: 'snapshot-machine' });
  const composition: { manager?: ExecutionRunHostBridgeContract } = {};
  const session = createMutableApiSessionClientFixture({ sessionId, metadata,
    overrides: { getBackendTarget: () => backendTarget,
      ...createSnapshotSessionPendingTransport(),
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
      setExecutionRunWorkerUpdateSource: source => { composition.manager = source; } } });
  const controls: Partial<SessionRuntimeControls> = {};
  applySessionRuntimeControls(controls, { readAppliedChildSelection: async () => ({ status: 'applied', backendTarget,
    modelId: 'parent-applied-model', connectedServices: null }) });
  const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
  const registration = registerSessionClientRuntimeHandlers({ rpcHandlerManager: rpc, token,
    serverId: configuration.activeServerId, serverUrl: configuration.apiServerUrl,
    readOwnerAccountCredentials: async () => credentials, metadataPath: home, metadata, sessionId, session,
    getSessionMetadata: () => metadata, sessionRuntimeControls: controls, getCurrentWorkspaceWrites: () => 'allow',
    enqueueSessionUserMessage: async () => {}, enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: true }),
    enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: true }),
    enqueueVoiceAgentTranscriptTurnCommitted: async () => ({ persisted: true, delivered: true }),
    sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }), getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
    persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
  });
  cleanups.push(async () => {
    await composition.manager?.dispose?.(); await registration.dispose(); applySessionRuntimeControls(controls, null);
  });
  // Observe the authority consumed by the real MCP composer without replacing
  // its internal logic. The native Session open below remains the output gate.
  if (!composition.manager) throw new Error('Missing registered Run owner');
  const interactionHost = Reflect.get(composition.manager, 'sessionInteractionHost') as NativeAgentSessionInteractionHostBinding;
  const compose = interactionHost.composeRunToolBinding;
  if (!compose) throw new Error('Missing canonical Run MCP composer');
  const mcpOccurrences: NativeAgentSessionRunToolBindingRequest[] = [];
  vi.spyOn(interactionHost, 'composeRunToolBinding').mockImplementation(async request => {
    const occurrence = request.readCurrentRunOccurrence(request.runId);
    expect(request.isCurrent(), 'Run authority must exist before native MCP composition').toBe(true);
    expect(occurrence?.isCurrent()).toBe(true);
    expect(occurrence?.runtimeLifetimeSignal.aborted).toBe(false);
    expect(request.signal.aborted).toBe(false);
    mcpOccurrences.push(request);
    return await compose(request);
  });
  const requestFor = (target = backendTarget, childSelection?: 'agentDefault') =>
    ExecutionRunStartRequestSchema.parse({ intent: 'delegate', backendTarget: target,
      ...(target === backendTarget ? { profileId: 'acme.snapshot/captured-delegate', profileSourceCustody: parentBinding.sourceCustody } : {}),
      instructions: 'Explain the captured comparison.', permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
      ...(childSelection ? { childSelection } : {}) });
  const start = (target = backendTarget, childSelection?: 'agentDefault') => rpc.handleRequest({
    method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START, callerAuthority: 'present_user',
    params: requestFor(target, childSelection),
  });
  try {
    const preview = await createRunnerExecutionRunSnapshotResolver({ sessionId, machineId: 'snapshot-machine' })(backendTarget);
    try {
      const profile = preview.profileCatalog.runtimeProfilesById.get('acme.snapshot/captured-delegate');
      if (!profile?.prepareStartParams) throw new Error('Missing daemon-admitted contributed profile');
      const prepared = await profile.prepareStartParams({ request: requestFor(), cwd: home, sessionId });
      expect(prepared?.instructions).toContain('daemon-admitted profile instructions');
    } finally { await preview.release?.(); }
    const inherited = await start();
    expect(inherited, JSON.stringify(inherited)).toMatchObject({ runId: expect.any(String) });
    const defaulted = await start(childTarget, 'agentDefault');
    expect(defaulted, JSON.stringify(defaulted)).toMatchObject({ runId: expect.any(String) });
    const choice = await start(childTarget);
    expect(choice).toMatchObject({ ok: false, errorCode: 'execution_run_child_choice_required',
      details: { childChoice: expect.any(Object) } });
    expect(normalizeExecutionRunRpcPayload(choice, { executionRunStart: true })).toMatchObject({
      ok: false, code: 'execution_run_child_choice_required', details: { childChoice: expect.any(Object) },
    });
    for (const method of [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1]) {
      const rowless = await rpc.handleRequest({
        method: sessionId + ':' + method, callerAuthority: 'present_user',
        params: { runId: null, resume: false, start: requestFor(childTarget) },
      });
      expect(rowless).toMatchObject({ ok: false, errorCode: 'execution_run_child_choice_required',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' }, childChoice: expect.any(Object) } });
    }
    await vi.waitFor(async () => {
      for (const started of [inherited, defaulted]) {
        const run = composition.manager?.getPublic(ExecutionRunStartResponseSchema.parse(started).runId);
        if (run?.status === 'failed') throw new Error('Native child Run failed: ' + JSON.stringify(run.error));
      }
      const opens = (await readFile(join(home, 'native-opens.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(opens).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: 'parent', modelId: 'parent-applied-model', sessionId }),
        expect.objectContaining({ agentId: 'child', modelId: null, sessionId }),
      ]));
    }, { timeout: 10_000 });
    for (const started of [inherited, defaulted]) {
      const runId = ExecutionRunStartResponseSchema.parse(started).runId;
      expect(mcpOccurrences.some(request => request.runId === runId)).toBe(true);
    }
    const inheritedRunId = ExecutionRunStartResponseSchema.parse(inherited).runId;
    const owned = composition.manager?.get(inheritedRunId);
    if (!owned) throw new Error('Missing canonical admitted Run');
    await retainExecutionRunState({ ...owned, runId: 'other-session-run', sessionId: 'other-session' });
    const app = transport.app as ReturnType<typeof import('@/daemon/controlServer').createDaemonControlApp>;
    const materialize = (runId: string) => app.inject({ method: 'POST', url: '/connected-service-run/materialize',
      headers: { 'x-happier-daemon-token': deriveConnectedServiceRunMaterializeToken(daemon.controlToken) },
      payload: { runId, runnerPid: process.pid, agentId: 'codex', cwd: home,
        connectedServices: { v: 2, bindingsByServiceId: {} } } });
    for (const runId of ['missing-run', 'other-session-run']) {
      expect((await materialize(runId)).json()).toMatchObject({
        errorCode: 'connected_service_run_materialization_blocked',
        errorMessage: 'Execution-run connected services runner identity is not current',
      });
    }
    // This deliberately native input has no subscription to issue. The real HTTP
    // materializer must reach credential resolution for the owned Run, while a
    // missing or other-Session Run refuses before that boundary.
    const ownedMaterialization = await materialize(inheritedRunId);
    expect(ownedMaterialization.json()).not.toMatchObject({
      errorMessage: 'Execution-run connected services runner identity is not current',
    });
    // Complete a retained turn and send another through the real native loader
    // and daemon snapshot channel, before any fixture retirement or reload.
    const retainedOwner = composition.manager;
    const retainedResponse = await rpc.handleRequest({
      method: sessionId + ':' + SESSION_RPC_METHODS.EXECUTION_RUN_START, callerAuthority: 'present_user',
      params: ExecutionRunStartRequestSchema.parse({ intent: 'delegate', backendTarget: childTarget, childSelection: 'agentDefault',
        instructions: 'retained-snapshot-turn-1', permissionMode: 'read_only',
        localInputId: 'retained-initial',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' }),
    });
    expect(retainedResponse, JSON.stringify(retainedResponse)).toMatchObject({ runId: expect.any(String) });
    const retained = ExecutionRunStartResponseSchema.parse(retainedResponse);
    await vi.waitFor(() => {
      expect(retainedOwner.get(retained.runId)).toMatchObject({ sessionId });
      const current = retainedOwner.getPublic(retained.runId);
      const firstTurn = [current?.inputTurns?.current, current?.inputTurns?.last]
        .find(turn => turn?.inputIds.includes('retained-initial'));
      expect(firstTurn, JSON.stringify(current)).toMatchObject({ state: 'completed' });
      expect(current).toMatchObject({ status: 'running', turnInFlight: false });
    }, { timeout: 10_000 });
    expect(await retainedOwner.send(retained.runId, { message: 'retained-snapshot-turn-2', localInputId: 'retained-followup' }))
      .toMatchObject({ ok: true });
    expect(await retainedOwner.waitForInputTurn(retained.runId, 'retained-followup')).toMatchObject({ turn: { state: 'completed' } });
    expect(await readFile(join(home, 'native-inputs.jsonl'), 'utf8')).toContain('retained-snapshot-turn-2');
    expect(retainedOwner.getPublic(retained.runId)).toMatchObject({ status: 'running', turnInFlight: false });
    expect(pluginReloadController.getState().activeRegistry).toBeNull();
    // Actual controller disposal observes lease custody, rather than release call counts.
    const disposed = vi.spyOn(fixture.registry, 'dispose');
    await fixture.lease.release();
    const replacement = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
      contributes: createResolvedContributionRegistry({}), pluginIds: [] });
    await fixture.controller.adoptPreparedRuntimeRegistry({ registry: replacement,
      changedPluginIds: ['acme.snapshot'], runningSessionDisposition: 'retainRunningSessions' });
    expect(disposed).not.toHaveBeenCalled();
    // Control of the incumbent Run must use its admitted profile, not attempt
    // a new executable acquisition from the replacement's empty catalog.
    const incumbentAction = await composition.manager?.applyAction(
      ExecutionRunStartResponseSchema.parse(inherited).runId, { actionId: 'snapshot.unsupported', input: {} },
    ).catch(error => ({ ok: false, errorCode: error.code }));
    expect(incumbentAction).toMatchObject({ ok: false, errorCode: 'execution_run_action_not_supported' });
    const parentSnapshot = [...snapshots].reverse().find(snapshot => snapshot.agent?.binding.agentId === backendTarget.backendId);
    if (!parentSnapshot) throw new Error('Missing admitted parent Run snapshot');
    expect(parentSnapshot.agent?.binding.sourceCustody).toEqual(parentBinding.sourceCustody);
    // Real Runs retain the instructions prepared at admission. A separate
    // post-reload resource read would exercise the ordinary publication fence,
    // not Run continuation (intentRegistry.prepareStartParams is the sole read).
    await vi.waitFor(async () => {
      const inputs = (await readFile(join(home, 'native-inputs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(inputs).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: 'parent',
        text: expect.stringContaining('daemon-admitted profile instructions') })]));
    });
    await composition.manager?.dispose?.();
    for (const request of mcpOccurrences) {
      expect(request.isCurrent()).toBe(false);
      expect(request.readCurrentRunOccurrence(request.runId)).toBeNull();
    }
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1));
    expect(daemonRequests.some(request => request.operation.kind === 'execution_run.snapshot.release_v1')).toBe(true);
    // An abandoned catalog acquisition is reclaimed through the same tracked
    // exit callback as a Run whose runner dies before reporting cleanup.
    const resolver = createRunnerExecutionRunSnapshotResolver({ sessionId, machineId: 'snapshot-machine' });
    await resolver();
    const replacementDisposed = vi.spyOn(replacement, 'dispose');
    const next = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
      contributes: createResolvedContributionRegistry({}), pluginIds: [] });
    await fixture.controller.adoptPreparedRuntimeRegistry({ registry: next,
      changedPluginIds: [], runningSessionDisposition: 'retainRunningSessions' });
    expect(replacementDisposed).not.toHaveBeenCalled();
    // A replacement between the actual daemon response and consumer admission
    // cannot publish an acquired snapshot. Exit cleanup reclaims its old lease.
    replaceAuthorityAfterAcquisition = true;
    await expect(resolver()).rejects.toMatchObject({ code: 'execution_run_contribution_snapshot_unavailable' });
    await daemon.onChildExited(launcherPid, { reason: 'process-exited', code: 0, signal: null });
    expect(trackedSessions.has(launcherPid)).toBe(false);
    await vi.waitFor(() => expect(replacementDisposed).toHaveBeenCalledTimes(1));
    await expect(resolver()).rejects.toMatchObject({ code: 'execution_run_contribution_snapshot_unavailable' });
  } finally {
    await composition.manager?.dispose?.(); await registration.dispose(); await daemon.stopControlServer(); await fixture.dispose();
    applySessionRuntimeControls(controls, null);
    cleanups.splice(0);
  }
}, 180_000);
