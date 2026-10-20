import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { startExecutionRun } from '@/agent/runtime/bridges/executionRun/startExecutionRun';
import { stopExecutionRun } from '@/agent/runtime/bridges/executionRun/executionRunStop';
import { finishExecutionRun } from '@/agent/runtime/bridges/executionRun/finishExecutionRun';
import { projectExecutionRunPublicState } from '@/agent/runtime/bridges/executionRun/publicState';
import { createNativeAgentExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import * as sessionRpc from '@/session/transport/rpc/sessionRpc';
import { createProjectSetupTrustClient } from '@/workspaces/projectSetup/projectSetupTrust';
import { createProjectSetupSuccessStore } from '@/workspaces/projectSetup/projectSetupSuccess';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { logger } from '@/ui/logger';
import { createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { AgentRuntimeDaemonServiceRequestV1Schema, AGENT_RUNTIME_DAEMON_SERVICES_PATH } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { configuration } from '@/configuration';
import * as processIdentity from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { prepareRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { authorizeResolvedAgentNativeExecLaunchForHost, issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The private HTTP listener is the transport boundary. Its production dispatcher,
// installed finite registration, requester custody and Exec remain real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });

it.each([{ name: 'Claude', agentId: 'claude' }, { name: 'configured ACP', agentId: 'custom-acp' },
  { name: 'external plugin', agentId: undefined }] as const)('recovers fresh Session custody before native launch for $name and refuses a foreign requester', async ({ agentId }) => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, agentId);
  // Background workflow/Session authoring can borrow the daemon's installed
  // credentials between native starts. Keep its real stored-identity fence;
  // a fixture that always returns current cannot catch this cross-owner loss.
  if (!h.installedCredentials) throw new Error('Missing installed Account fixture');
  const child = await prepareRequesterSessionBootstrap({ credentials: h.installedCredentials,
    attribution: h.f.bootstrap.attribution,
    boundary: { serverId: 'session-home', serverHttpBaseUrl: 'https://session-home.test', happyHomeDir: h.f.directory },
    verifyMachineAdmissionCurrent: h.f.isHomeCurrent });
  expect(child).not.toBeNull();
  onTestFinished(() => child?.cleanupOnFailure());
  await h.requester.dispose();
  delete h.tracked.requesterSessionRuntimeContext;
  const services = await prepareRunnerDaemonPluginServices({ invocationId: 'cold-invocation', signal: h.signal,
    local: createUnavailablePluginServices(), dispatch: async operation => {
      const response = await h.dispatch(operation);
      if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
      if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing daemon service result');
      return decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
    } });
  const launch = await authorizeResolvedAgentNativeExecLaunchForHost(services.exec,
    { command: '/installed/agent', args: [], cwd: h.cwd, env: {} }, h.signal,
    issueAgentNativeLaunchQualifierForHost(services.exec));
  expect(launch).toMatchObject({ command: '/installed/agent', cwd: h.cwd });
  expect(h.tracked.requesterSessionRuntimeContext?.bootstrap.getBoundSessionId()).toBe(h.sessionId);
  expect(h.nativeEffects()).toBe(1);
  await launch.release();
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
  await h.tracked.requesterSessionRuntimeContext?.dispose();
  delete h.tracked.requesterSessionRuntimeContext;
  h.tracked.requesterWorkAttributionV1 = { ...h.f.bootstrap.attribution, accountId: 'foreign' };
  const before = h.nativeEffects();
  const prepared = await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase() });
  if (prepared.ok) {
    expect(await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...h.operationBase(),
      launch: { command: '/installed/agent', args: [], cwd: h.cwd, env: {} } })).toMatchObject({ ok: false });
  } else expect(prepared.error.code).toBeTruthy();
  expect(h.nativeEffects()).toBe(before);
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
  h.tracked.requesterWorkAttributionV1 = h.f.bootstrap.attribution;
  h.tracked.requesterSessionRuntimeContext = await h.replaceRequesterRuntime();
  await writeStoredCredentialsForServerId('session-home', { token: 'replaced-installed-owner', encryption: null });
  const diagnostic = vi.spyOn(logger, 'debug');
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase() })).toMatchObject({ ok: true });
  expect(await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...h.operationBase(),
    launch: { command: '/installed/agent', args: [], cwd: h.cwd, env: {} } })).toMatchObject({
      ok: false, error: { code: 'project_finite_execution_unavailable' },
    });
  expect(diagnostic.mock.calls).toEqual(expect.arrayContaining([[
    '[ProjectFinite] Runtime resolution refused', expect.objectContaining({ reason: 'installed_not_current' }),
  ], [
    '[PluginExec] Native launch requester refusal', { reason: 'finite_runtime_unavailable', sessionId: h.sessionId },
  ]]));
  const refusals = diagnostic.mock.calls.filter(([message]) => String(message).includes('Runtime resolution refused'));
  expect(JSON.stringify(refusals)).not.toContain(h.installedCredentials.token);
  expect(JSON.stringify(refusals)).not.toContain('replaced-installed-owner');
  expect(h.nativeEffects()).toBe(before);
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
}, 120_000);

it('recovers the captured Session requester before Project preparation and projects the original Session-hosted Run through startup and Account Action', async () => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control);
  // Account refresh retires its previous runtime. The tracked capture can lag
  // behind the existing resolver, which now supplies the real replacement.
  const recoveredRequester = await h.replaceRequesterRuntime();
  expect(await h.requester.isCurrent()).toBe(false);
  expect(await recoveredRequester.isCurrent()).toBe(true);
  const resumedPreparation = await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase() });
  expect(resumedPreparation, JSON.stringify(resumedPreparation)).toMatchObject({ ok: true });
  expect(h.nativeEffects()).toBe(0);
  const launched = await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...h.operationBase(),
    launch: { command: '/installed/agent', args: ['--resume'], cwd: h.cwd, env: {} } });
  expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true, result: { kind: 'plugin_services.result_v1' } });
  expect(h.nativeEffects()).toBe(1);
  expect(h.accountReads()).not.toContain('Bearer custodian-token');
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
  // Resume can also leave the capture entirely absent; it uses the same owner.
  delete h.tracked.requesterSessionRuntimeContext;
  expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase() })).toMatchObject({ ok: true });
  expect(await h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...h.operationBase(),
    launch: { command: '/installed/agent', args: ['--resume'], cwd: h.cwd, env: {} } })).toMatchObject({ ok: true });
  await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
  // The process controller has one lifetime. Exercise warm, resumed and Run
  // launches in that same daemon before its ordinary fixture-owned shutdown.
  h.tracked.requesterSessionRuntimeContext = recoveredRequester;
  const refusalLog = vi.spyOn(logger, 'warnLocalFile');
  const { dispatch, operationBase, nativeEffects, accountReads, cwd } = h;
  const beforeWarmLaunch = nativeEffects();
  const prepared = await dispatch({ kind: 'plugin_services.prepare_v1', ...operationBase() });
  expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
  expect(nativeEffects()).toBe(beforeWarmLaunch);
  const launch = await dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...operationBase(),
    launch: { command: '/installed/agent', args: ['--resume'], cwd, env: { ORIGINAL: 'host' } } });
  expect(launch, JSON.stringify(launch)).toMatchObject({ ok: true, result: { kind: 'plugin_services.result_v1' } });
  if (!launch.ok || launch.result.kind !== 'plugin_services.result_v1') throw new Error('Missing authorized Agent tuple');
  expect(decodeRunnerDaemonPluginServiceWireValueV1(launch.result.value)).toMatchObject({
    launch: { command: '/installed/agent', args: ['--resume'], cwd, env: { PATH: '/native/bin', NATIVE: 'active' } } });
  expect(nativeEffects()).toBe(beforeWarmLaunch + 1);
  expect(accountReads()).not.toContain('Bearer custodian-token');
  const refused = await dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...operationBase(),
    launch: { command: '/installed/agent', args: [], cwd: join(h.f.directory, 'foreign-project'), env: {} } });
  expect(refused).toMatchObject({ ok: false, error: { code: 'outside_root',
    cause: { code: 'outside_root', stage: 'dispatch' } } });
  const diagnostic = refusalLog.mock.calls.map(([message]) => message).find(message =>
    message.includes('runner_plugin_services_dispatch_refused'));
  expect(diagnostic).toBeDefined();
  expect(JSON.parse(diagnostic!)).toEqual({ kind: 'runner_plugin_services_dispatch_refused',
    operation: 'plugin_exec.resolved_agent_launch.authorize_v1', cause: { code: 'outside_root', stage: 'dispatch' } });
  expect(diagnostic).not.toContain(h.f.directory);
  await dispatch({ kind: 'plugin_services.close_v1', ...operationBase() });
  expect(await dispatch({ kind: 'plugin_services.prepare_v1', ...operationBase('misbound-session'),
    executionRunCwd: cwd })).toMatchObject({ ok: false, error: {
      cause: { code: 'plugin_services_invocation_context_unavailable', stage: 'invocation_context' } } });
  // A child Run can author another checkout. Parent Session cwd is neither
  // that Run's workspace nor its Project-membership decision.
  const parentCwd = join(h.f.directory, 'unassociated-parent');
  await mkdir(parentCwd);
  h.tracked.runnerAgentInvocationContext = { ...h.tracked.runnerAgentInvocationContext!, cwd: parentCwd };
  // Process census is an OS boundary. Keep the real runner-entrypoint parser
  // and authority-file reader while modelling this test process as the runner.
  const runnerCommand = `${process.execPath} ${join(h.f.directory, '.runner-snapshots', 'fixture-runner', 'index.mjs')}`;
  h.runner.snapshotIdentity = 'snapshot:fixture-runner';
  h.runner.processCommandHash = hashProcessCommand(runnerCommand);
  h.tracked.processCommandHash = h.runner.processCommandHash;
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid,
    processStartTimeMs: h.runner.processStartTimeMs, command: runnerCommand });
  const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing });
  await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: h.f.directory,
    publicReleaseRing: configuration.publicReleaseRing, path: authorityFilePath,
    sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129 });
  // Only the HTTP boundary is substituted. The real retained runner source,
  // private requester, strict request parser and installed daemon stay composed.
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(url)).pathname !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) return await homeFetch(url, init);
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    return Response.json(await h.dispatch(request.operation, request.context.executionRunSnapshotId));
  });
  for (const choice of ['thisTime', 'skip', 'untilChanged', 'changed', 'cancel', 'deny', 'stop', 'refused'] as const) {
    const beforeNative = h.nativeEffects();
    await h.requireSetup(`printf setup-${choice}`);
    const acquired = await h.dispatch({ kind: 'execution_run.snapshot.acquire_v1',
      backendTarget: { kind: 'backend', backendId: h.retainedAgent.agentId } });
    if (!acquired.ok || acquired.result.kind !== 'execution_run.snapshot' || !acquired.result.agent) throw new Error('Missing actual Run snapshot');
    const snapshotId = acquired.result.snapshotId;
    // Native Agent open is the external boundary. The actual Run admission,
    // provisioning, Stop and terminal publication owners stay composed.
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    let releaseNativeOpen!: () => void;
    let refuseNativeOpen!: (error: unknown) => void;
    const nativeAuthorization = new Promise<void>((resolve, reject) => { releaseNativeOpen = resolve; refuseNativeOpen = reject; });
    void nativeAuthorization.catch(() => undefined);
    const runIdForLease = randomUUID();
    const createRuntime: Parameters<typeof startExecutionRun>[0]['createRuntime'] = options => {
      const native = createNativeAgentExecutionRunHostRuntime({
        runtime: { executionRuns: { async open() {
          await nativeAuthorization;
          return { async send() { return { status: 'admitted' as const }; },
            async stop() { return { status: 'requested' as const }; },
            watch() { return { dispose() {} }; }, async dispose() {} };
        } } },
        lease: { pluginId: h.retainedAgent.pluginId, pluginVersion: h.retainedAgent.pluginVersion,
          agentId: h.retainedAgent.agentId, localAgentId: 'agent', occurrenceId: runIdForLease, isCurrent: () => true },
        options: { ...options, cwd: h.cwd, scope: 'session' }, supportsResume: false,
      });
      // Admit the fake native open through the real adapter. Its authorization
      // remains held until the original daemon preparation below settles.
      void native.provisionRuntime({ initialPrompt: 'Inspect the workspace.' }).catch(() => undefined);
      return native;
    };
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    onTestFinished(() => voiceAgentManager.dispose());
    const finish: Parameters<typeof stopExecutionRun>[0]['finishRun'] = async (runId, next, toolResult) => {
      await finishExecutionRun({ runId, next, toolResult, runs, controllers, budgetRegistry: null,
        parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
        enqueueMarkerWrite: async (_id, write) => { await write(); }, terminalMarkerWritePromises: new Map() });
    };
    const started = await startExecutionRun({ params: { sessionId: h.sessionId, intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: h.retainedAgent.agentId }, instructions: '', permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'long_lived', ioMode: 'request_response' },
      parentProvider: 'daemon.executionRuns', sendAcp: async () => {}, streamedTranscriptSession: null,
      createRuntime, getNowMs: Date.now, budgetRegistry: null, runs, controllers,
      enqueueMarkerWrite: async (_id, write) => { await write(); }, writeActivityMarker: async () => {}, finishRun: finish,
      executeBoundedRun: async () => { throw new Error('Expected controller-owned provisioning'); },
      send: async () => ({ ok: true }), voiceAgentManager });
    const runId = started.runId;
    const controller = controllers.get(runId);
    if (controller?.kind !== 'backend') throw new Error('Missing actual Run controller');
    onTestFinished(async () => { await stopExecutionRun({ runId, runs, controllers, voiceAgentManager, getNowMs: Date.now, finishRun: finish }); });
    // Substitute only the Session socket transport with its actual controller.
    vi.spyOn(sessionRpc, 'callSessionRpc').mockImplementation(async request => {
      expect(request.sessionId).toBe(h.sessionId);
      expect(request.request).toEqual({ runId });
      expect(request.token === recoveredRequester.bootstrap.credentials.token).toBe(true);
      if (request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_GET)) {
        return ExecutionRunGetResponseSchema.parse({ run: projectExecutionRunPublicState(runs.get(runId)!) });
      }
      if (request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)) {
        return await stopExecutionRun({ runId, runs, controllers, voiceAgentManager, getNowMs: Date.now, finishRun: finish });
      }
      throw new Error('Unexpected Session transport method');
    });
    if (choice === 'thisTime') {
      expect(await h.dispatch({ kind: 'plugin_services.prepare_v1', ...h.operationBase(runId) }, snapshotId))
        .toMatchObject({ ok: false, error: { cause: { code: 'plugin_services_invocation_context_unavailable', stage: 'invocation_context' } } });
      expect(h.nativeEffects()).toBe(beforeNative);
    }
    // Use the actual Session-owned Run service constructor rather than giving
    // its proxy a hand-authored cwd carrier. Removing caller wiring must fail.
    const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: h.f.directory,
      publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: h.sessionId,
      executionRunSnapshot: acquired.result, occurrenceId: acquired.result.agent.descriptor.occurrenceId,
      runtimeAuthority: acquired.result.agent.descriptor.runtimeAuthority });
    if (!source) throw new Error('Missing real retained Run source');
    onTestFinished(() => source.retire?.());
    await source.createInvocationServices({ pluginId: h.retainedAgent.pluginId, pluginVersion: h.retainedAgent.pluginVersion,
      agentId: h.retainedAgent.agentId, occurrenceId: acquired.result.agent.descriptor.occurrenceId,
      correlationId: runId, processOwner: { kind: 'run', runId, sessionId: h.sessionId }, cwd: h.cwd,
      environment: {}, providerBindingActive: false, signal: controller.backend.getRuntimeLifetimeSignal(), isOccurrenceCurrent: () => true });
    const launching = h.dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...h.operationBase(runId),
      launch: { command: '/installed/agent', args: ['--cold-run'], cwd: h.cwd, env: {} } }, snapshotId);
    let completed: Awaited<typeof launching> | undefined;
    void launching.then(result => { completed = result; }).catch(() => undefined);
    void launching.then(result => {
      if (result.ok) releaseNativeOpen();
      else refuseNativeOpen(Object.assign(new Error('Native preparation refused'), { code: result.error.code }));
    });
    // This is separately authenticated Account ingress. Session custody starts
    // the Run; it does not grant the later human decision.
    const rpcContext = { callerAuthority: 'present_user' as const,
      machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
        installationId: h.f.installation.installationId, role: 'use' as const, encryptionMode: 'plain' as const },
      verifyMachineAdmissionCurrent: recoveredRequester.bootstrap.isCurrent };
    expect(await h.machine.resolveProjectFiniteRuntime({ signal: h.signal, ...rpcContext }),
      'The installed Account ingress must resolve its original Project runtime').not.toBeNull();
    const read = async () => ActionOperationGetV1ResponseSchema.parse(await h.machine.invokeLocalMachineAction(
      ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: runId, refreshSetupReview: true }, { signal: h.signal, rpcContext }));
    const held = await vi.waitFor(async () => {
      expect(completed, 'Original native launch must remain pending on setup').toBeUndefined();
      const result = await read();
      expect(result).toMatchObject({ kind: 'found', operation: { operationId: runId, actionId: 'execution.run.start',
        setupReview: { code: 'project_setup_consent_required' } } });
      return result;
    });
    if (held.kind !== 'found' || !held.operation.setupReview || held.operation.domainRef?.kind !== 'projectCommand') {
      throw new Error('Original native Run hold unavailable');
    }
    expect(h.nativeEffects()).toBe(beforeNative);
    expect(h.admission.dependencies()).toMatchObject([{ operationId: runId, state: 'setup' }]);
    const digest = held.operation.setupReview.reviewedEffectDigest;
    expect(held.operation.cancellation).toBe('supported');
    const decide = () => h.machine.invokeLocalMachineAction(RPC_METHODS.DAEMON_PROJECTS_PREPARE, {
      workspace: { serverId: 'session-home', machineId: 'machine', workspaceId: 'workspace', rootPath: h.cwd },
      heldOperationId: runId, phase: 'setup', expectedEffectDigest: digest,
      ...(choice === 'skip' ? { skipForInvocation: true } : { consentScope: 'thisTime' }),
    }, { signal: h.signal, rpcContext, localActionContext: { surface: 'rpc', authority: 'present_user', actionRequestId: randomUUID() } });
    if (choice === 'deny' || choice === 'stop' || choice === 'refused') {
      if (choice === 'deny') {
        expect(await h.machine.invokeLocalMachineAction(ACTION_OPERATION_RPC_METHODS_V1.cancel,
          { operationId: runId }, { signal: h.signal, rpcContext })).toMatchObject({ kind: 'requested' });
      } else if (choice === 'stop') {
        expect(await stopExecutionRun({ runId, runs, controllers, voiceAgentManager, getNowMs: Date.now, finishRun: finish })).toEqual({ ok: true });
      } else {
        // Observe real terminal publication before invocation disposal. A
        // running-only daemon projection would still offer a resumable review.
        await finish(runId, { status: 'failed', finishedAtMs: Date.now(), error: { code: 'project_setup_refused' } }, { output: {} });
        expect(await read()).toMatchObject({ kind: 'found', operation: { state: 'failed', error: { errorCode: 'project_setup_refused' } } });
        const failed = await read();
        if (failed.kind !== 'found') throw new Error('Missing terminal controller projection');
        expect(failed.operation.setupReview).toBeUndefined();
        expect(await decide()).toMatchObject({ ok: false, errorCode: 'project_setup_review_unavailable' });
        await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(runId) }, snapshotId);
      }
      expect(await launching).toMatchObject({ ok: false });
      await vi.waitFor(() => expect(runs.get(runId)?.status).toBe(choice === 'refused' ? 'failed' : 'cancelled'));
      const terminal = await read();
      if (terminal.kind === 'found') {
        expect(terminal.operation.state).toBe(choice === 'refused' ? 'failed' : 'cancelled');
        expect(terminal.operation.setupReview).toBeUndefined();
      }
      expect(await decide()).toMatchObject({ ok: false, errorCode: 'project_setup_review_unavailable' });
      expect(h.nativeEffects()).toBe(beforeNative);
      expect(h.admission.dependencies()).toHaveLength(0);
      await source.retire?.();
      continue;
    }
    if (choice === 'changed') {
      await h.requireSetup('printf changed-effect');
      expect(await decide()).toMatchObject({ operation: { operationId: runId,
        setupReview: { code: 'project_setup_effect_changed' } } });
      expect(completed).toBeUndefined();
      expect(h.admission.dependencies()).toMatchObject([{ operationId: runId, state: 'setup' }]);
    }
    if (choice === 'cancel' || choice === 'changed') {
      await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(runId) }, snapshotId);
      expect(await launching).toMatchObject({ ok: false });
      expect(await decide()).toMatchObject({ ok: false, errorCode: 'project_setup_review_unavailable' });
      expect(h.nativeEffects()).toBe(beforeNative);
      expect(h.admission.dependencies()).toHaveLength(0);
      continue;
    }
    if (choice === 'untilChanged') {
      const approvingAccount = await readStoredCredentialsForServerId('session-home');
      if (!approvingAccount) throw new Error('Missing approving Account credentials');
      await createProjectSetupTrustClient({ credentials: approvingAccount, serverHttpBaseUrl: 'https://session-home.test' })
        .approveReviewedEffect({ project: { serverId: 'session-home', projectId: 'project' }, expectedRevision: 'absent',
          authority: 'present_user', reviewedEffectDigest: digest, currentEffectDigest: digest, approvedAtMs: 2 });
      await read();
    } else {
      expect(await decide(), choice).toMatchObject({ operation: { operationId: runId } });
    }
    expect(await launching).toMatchObject({ ok: true, result: { kind: 'plugin_services.result_v1' } });
    expect(h.trustWrites()).toBe(choice === 'untilChanged' ? 2 : 1);
    const runtime = await h.machine.resolveProjectFiniteRuntime({ signal: h.signal, requesterSessionBootstrap: recoveredRequester.bootstrap });
    if (!runtime?.successHomeDir) throw new Error('Missing target completion owner');
    const completion = await createProjectSetupSuccessStore({ homeDir: runtime.successHomeDir }).read({
      serverId: 'session-home', machineId: 'machine', workspaceRefId: 'workspace' });
    if (choice === 'skip') expect(completion?.reviewedEffectDigest).not.toBe(digest);
    else expect(completion?.reviewedEffectDigest).toBe(digest);
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase(runId) }, snapshotId);
    expect(h.admission.dependencies()).toHaveLength(0);
    expect(await read()).toEqual({ kind: 'not_found' });
  }
  // Recovery must still refuse a requester whose real Machine admission retired.
  h.tracked.runnerAgentInvocationContext = { ...h.tracked.runnerAgentInvocationContext!, cwd };
  delete h.tracked.requesterSessionRuntimeContext;
  h.f.retire();
  const beforeRefusedLaunch = nativeEffects();
  expect(await dispatch({ kind: 'plugin_services.prepare_v1', ...operationBase() })).toMatchObject({ ok: true });
  expect(await dispatch({ kind: 'plugin_exec.resolved_agent_launch.authorize_v1', ...operationBase(),
    launch: { command: '/installed/agent', args: [], cwd, env: {} } })).toMatchObject({
      ok: false, error: { cause: { code: 'runner_plugin_services_unavailable', stage: 'dispatch' } },
    });
  expect(nativeEffects()).toBe(beforeRefusedLaunch);
  await dispatch({ kind: 'plugin_services.close_v1', ...operationBase() });
}, 120_000);
