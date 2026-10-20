import axios from 'axios';
import childProcesses from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { PendingActivationFailureDetailsV1Schema, PendingActivationFailureRequestV1Schema } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { HomeTargetResolutionError } from '@happier-dev/cli-common/homeTarget';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { logger } from '@/ui/logger';
import * as cliProcess from '@/utils/spawnHappyCLI';
import { activatePendingInactiveSession } from '@/daemon/sessions/activatePendingInactiveSession';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';
import { activateRequesterPendingSession } from '@/daemon/sessions/pendingSessionActivationRecovery';
import { releaseUnretainedRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { clearSessionMarkerConnectedServiceRestartIntent, hashProcessCommand, writeSessionMarker } from '@/daemon/sessionRegistry';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
vi.mock('@/utils/spawnHappyCLI', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/spawnHappyCLI')>();
  return { ...actual, spawnHappyCLI: vi.fn(() => { throw new Error('Fixture native launch'); }) };
});
// Only the OS listener is replaced; startup, exit supervision and requester custody remain real.
vi.mock('@/daemon/controlServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43127, stop: async () => {} };
  } };
});
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.control = null; });

it.each([
  { route: 'owner', stop: 'persisted' }, { route: 'owner', stop: 'absent' },
  { route: 'requester', stop: 'persisted' }, { route: 'requester', stop: 'absent' },
  { route: 'owner', stop: 'during-preparation' }, { route: 'owner', stop: 'then-person-resume' },
  { route: 'owner', stop: 'guard' },
  { route: 'owner', stop: 'guard-background' },
  { route: 'owner', stop: 'mismatched-context' },
] as const)('does not promote retained Pending input to person Resume ($route / $stop)', async scenario => withTempHappyCliEntrypoint(async runner => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'claude', false, undefined, pluginReloadController,
    { processEnv: { HAPPIER_CLAUDE_PATH: process.execPath } });
  // The runner executable is an OS fixture, not a separately built CLI artifact.
  vi.stubEnv('HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', runner);
  h.pidToTrackedSession.clear();
  const stopped = scenario.stop !== 'absent' && scenario.stop !== 'guard' && scenario.stop !== 'guard-background'
    && scenario.stop !== 'mismatched-context';
  const stop = { v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 20 };
  const metadata = { machineId: 'machine', path: h.cwd, flavor: 'claude', claudeSessionId: 'original-conversation',
    ...(stopped && scenario.stop !== 'during-preparation' ? { sessionExplicitStopV1: stop } : {}) };
  const requestId = 'discussion-follow-v1:retained-original';
  const raw = createSessionRecordFixture({ id: h.sessionId, encryptionMode: 'plain', metadata: JSON.stringify(metadata),
    machineId: 'machine', path: h.cwd, pendingCount: 1, pendingVersion: 1,
    pendingActivationAuthorization: { requestId, requestedAt: 30, status: 'waiting', admittedTarget: {
      homeId: 'srv_requester_home', accountId: 'requester', sessionId: h.sessionId, machineId: 'machine',
      installationId: h.f.installation.installationId } } });
  let sessionReads = 0;
  const get = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (url, ...args) => {
    const path = new URL(String(url)).pathname;
    if (path === `/v2/sessions/${h.sessionId}`) {
      // Home commits Stop after Pending's final authorization read, before the
      // canonical launch owner revalidates persisted admission.
      if (++sessionReads === 3 && scenario.stop === 'during-preparation') {
        raw.metadata = JSON.stringify({ ...metadata, sessionExplicitStopV1: stop });
      }
      return { status: 200, data: { session: raw } };
    }
    if (path === `/v2/sessions/${h.sessionId}/pending`) return { status: 200, data: { pending: [
      { localId: requestId, messageRole: 'user', requestedAction: { v: 1, kind: 'enqueue' }, deliveryStatus: { status: 'queued' } },
    ] } };
    if (path === `/v1/access-keys/${h.sessionId}/machine`) return { status: 200,
      data: { accessKey: { id: 'existing-session-machine-tuple' } } };
    return get(url, ...args);
  });
  const post = vi.mocked(axios.post).getMockImplementation()!;
  const failureReports: unknown[] = [];
  vi.mocked(axios.post).mockImplementation(async (url, ...args) => {
    if (new URL(String(url)).pathname.endsWith('/pending/activation/fail')) {
      failureReports.push(PendingActivationFailureRequestV1Schema.parse(args[0]));
      return { status: 200, data: { ok: true, didFail: true } };
    }
    return post(url, ...args);
  });
  if (scenario.stop === 'guard' || scenario.stop === 'guard-background') {
    const child = childProcesses.spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    await once(child, 'message');
    const identity = await readProcessIdentityByPid(child.pid!);
    if (!identity) throw new Error('Missing owned Guard runner identity');
    const tracked = { ...h.tracked, pid: child.pid!, sessionRunnerPid: child.pid!, childProcess: child,
      processStartTimeMs: identity.processStartTimeMs, processCommandHash: hashProcessCommand(identity.command) };
    h.pidToTrackedSession.set(tracked.pid, tracked);
    raw.metadata = JSON.stringify({ ...metadata, hostPid: tracked.pid, hostProcessStartTimeMs: identity.processStartTimeMs });
    await writeSessionMarker({ pid: tracked.pid, happySessionId: h.sessionId, startedBy: 'daemon',
      processStartTimeMs: identity.processStartTimeMs, processCommandHash: tracked.processCommandHash });
    // Exact-runner physical Stop is the production Guard actuator composition;
    // it does not write person intent or claim a public Resume.
    expect(await h.daemon.stopSession(h.sessionId, { expectedTrackedRunner: { tracked,
      sessionRunnerPid: tracked.sessionRunnerPid, processStartTimeMs: tracked.processStartTimeMs,
      processCommandHash: tracked.processCommandHash }, beforeSignalExactTrackedRunner: () => true }))
      .toEqual({ status: 'stopped' });
    await exited;
  }
  // Physical process launch is the boundary; Pending, metadata, resume admission,
  // requester custody and installed Agent preparation remain production owners.
  const launches: unknown[] = [];
  const actualSpawn = childProcesses.spawn;
  vi.spyOn(childProcesses, 'spawn').mockImplementation((...args: Parameters<typeof childProcesses.spawn>) => {
    if (JSON.stringify(args[1] ?? []).includes('--started-by')) {
      launches.push(args);
      throw new Error('Fixture native launch');
    }
    return actualSpawn(...args);
  });
  syncBuiltinESMExports();
  vi.mocked(cliProcess.spawnHappyCLI).mockImplementation((...args) => {
    launches.push(args);
    throw new Error('Fixture native launch');
  });
  const resume = vi.spyOn(h.daemon, 'spawnSessionForInternalResume');
  if (scenario.stop === 'mismatched-context') {
    expect(await h.daemon.spawnSessionForInternalResume({ directory: h.cwd, existingSessionId: h.sessionId,
      executionAuthorization: { provenance: 'user_request', requestId, requestedAt: 30 } },
      { requestId: 'another-original', requestedAt: 30 })).toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
    expect(launches).toHaveLength(0);
    expect(failureReports).toEqual([]);
    return;
  }
  if (scenario.stop === 'guard-background') {
    // A background snapshot can retain the original tuple. Only the actual
    // Pending activation owner supplies current input demand as private context.
    expect(await h.daemon.spawnSessionForInternalResume({ directory: h.cwd, existingSessionId: h.sessionId,
      resume: 'original-conversation', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      executionAuthorization: { provenance: 'user_request', requestId, requestedAt: 30 } }))
      .toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
    expect(launches).toHaveLength(0);
    expect(failureReports).toEqual([]);
    expect(JSON.parse(raw.metadata!).sessionExplicitStopV1).toBeUndefined();
    return;
  }
  let result: Awaited<ReturnType<typeof activatePendingInactiveSession>> | undefined;
  if (scenario.route === 'owner') {
    result = await activatePendingInactiveSession({ ...h.daemon, credentials: h.requester.bootstrap.credentials,
      machineId: 'machine', sessionId: h.sessionId, requestId, pendingVersion: 1 });
  } else {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => String(input) === 'https://session-home.test/v1/features'
      ? Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: 'srv_requester_home' } } })) : originalFetch(input, init)));
    await activateRequesterPendingSession({ ...h.daemon, machineId: 'machine',
      binding: { sessionId: h.sessionId, attribution: h.requester.bootstrap.attribution },
      resolveRequesterSessionRuntimeContext: h.resolveRequesterRuntime,
      releaseRequesterSessionRuntimeContext: context => releaseUnretainedRequesterSessionRuntimeContext(context,
        [...h.pidToTrackedSession.values()].map(tracked => tracked.requesterSessionRuntimeContext)),
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: 'https://session-home.test', resolveCurrentMachineId: () => 'machine' }) });
  }
  if (stopped) {
    expect(launches).toHaveLength(0);
    expect(failureReports).toEqual([]);
    if (scenario.route === 'owner') expect(result).toEqual({ status: 'not-needed', reason: 'spawn-retryable' });
  } else {
    expect(launches, JSON.stringify({ sessionReads, resume: await resume.mock.results[0]?.value,
      failureReports, requesterStage: h.readRequesterRecoveryStage() })).toHaveLength(1);
    if (scenario.route === 'owner') expect(failureReports)
      .toMatchObject([{ requestId, requestedAt: 30, failureCode: 'runtime_start_failed' }]);
  }
  expect(resume).toHaveBeenCalledOnce();
  expect(result?.status).not.toBe('activated');
  expect(JSON.parse(raw.metadata!).sessionExplicitStopV1).toEqual(stopped ? stop : undefined);
  if (scenario.stop === 'then-person-resume') {
    // Fresh person intent still uses the public port; a failed physical launch
    // must not clear the hold it observed.
    await h.daemon.spawnSession({ directory: h.cwd, existingSessionId: h.sessionId, resume: 'original-conversation',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      executionAuthorization: { provenance: 'user_request', requestId: 'fresh-person-resume' } });
    expect(launches).toHaveLength(1);
    expect(JSON.parse(raw.metadata!).sessionExplicitStopV1).toEqual(stop);
  }
}), 120_000);

it.each(['definite', 'transient', 'replaced', 'wrong-target', 'continuation', 'continuation-stale',
  'continuation-unavailable', 'continuation-replaced', 'continuation-wrong-target'] as const)(
  'settles only the exact current pending activation after a post-webhook %s startup exit', async disposition => {
    const resolveOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: 'https://session-home.test',
      resolveCurrentMachineId: () => 'machine' });
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, undefined, undefined, {
      resolveCurrentMachineExecutionOriginContext: resolveOrigin,
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => String(input) === 'https://session-home.test/v1/features'
      ? Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: 'srv_requester_home' } } }))
      : originalFetch(input, init)));
    const warnings = vi.spyOn(logger, 'warn');
    const diagnostics = vi.spyOn(logger, 'debug');
    // A retry may prepare normally, but this test never launches a physical child.
    vi.spyOn(cliProcess, 'spawnHappyCLI').mockImplementation(() => { throw new Error('Native launch unavailable in fixture'); });
    const requestId = 'original-pending';
    const requestedAt = 10;
    h.tracked.spawnOptions!.executionAuthorization = { provenance: 'user_request', requestId, requestedAt };
    // This is the same producer used by host construction failure publication.
    const error = new PromptStackPreparationError('unavailable', { kind: 'doc', artifactId: 'private-reference' });
    if (disposition !== 'transient') Object.assign(error, { cause: new HomeTargetResolutionError('profile_missing', 'private-reference') });
    const continuation = disposition.startsWith('continuation');
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error',
      error: continuation ? Object.assign(new Error('Agent session continuation is unreachable.'), {
        name: 'AgentSessionContinuationUnreachableError',
      }) : error, occurredAt: disposition === 'continuation-stale' ? 0 : 20 });
    const pendingActivationAuthorization = { requestId: disposition.endsWith('replaced') ? 'newer-pending' : requestId,
      requestedAt, status: 'waiting' as const, admittedTarget: { homeId: 'srv_requester_home',
        accountId: 'requester', sessionId: h.sessionId, machineId: 'machine',
        installationId: disposition.endsWith('wrong-target') ? 'replacement-installation' : h.f.installation.installationId } };
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, ...args) => {
      if (new URL(String(url)).pathname === `/v2/sessions/${h.sessionId}`) {
        if (disposition === 'continuation-unavailable') throw Object.assign(new Error('private-response'), { code: 'ECONNREFUSED' });
        return { status: 200, data: {
        session: createSessionRecordFixture({ id: h.sessionId, encryptionMode: 'plain', metadata: '{}',
          ownerAccountId: 'requester', origin: { kind: 'none' }, pendingCount: 1,
          pendingActivationAuthorization, latestTurnStatus: 'failed', lastRuntimeIssue: issue }) } };
      }
      return get(url, ...args);
    });
    const reports: unknown[] = [];
    const post = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (url, data, config) => {
      if (new URL(String(url)).pathname === `/v2/sessions/${h.sessionId}/pending/activation/fail`) {
        expect(new URL(String(url)).origin).toBe('https://session-home.test');
        expect(config?.headers?.Authorization).toBe(`Bearer ${h.requester.bootstrap.credentials.token}`);
        reports.push({ body: PendingActivationFailureRequestV1Schema.parse(data),
          details: PendingActivationFailureDetailsV1Schema.parse(JSON.parse(String(config?.params?.failureDetails))) });
        return { status: 200, data: { ok: true, didFail: true } };
      }
      return post(url, data, config);
    });
    // The Home Machine terminal transport is unavailable; that does not invent a publisher or block supervision.
    vi.spyOn(h.machine, 'captureMachineSessionTerminal').mockRejectedValue(new Error('Home terminal transport unavailable'));
    await h.daemon.onChildExited(h.tracked.pid, { reason: 'process-exit', code: continuation ? 78 : 1, signal: null });
    if (disposition === 'definite' || disposition === 'continuation') {
      await expect.poll(() => reports, { timeout: 10_000 }).toEqual([{ body: { requestId, requestedAt,
        failureCode: 'runtime_start_failed' }, details: { reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED' } }]);
    } else if (disposition === 'transient') {
      await expect.poll(() => diagnostics.mock.calls.some(([message]) => String(message)
        .startsWith(`[DAEMON RUN] Respawning runner for session ${h.sessionId}`)), { timeout: 10_000 }).toBe(true);
    }
    if (disposition !== 'transient') {
      await expect.poll(() => warnings.mock.calls.some(([message]) => String(message)
        .includes(`Respawn suppressed for session ${h.sessionId} (${continuation
          ? 'continuation unreachable' : 'startup dependency: profile_missing'})`)), { timeout: 10_000 }).toBe(true);
      // The terminal notification queues this same mutation without awaiting
      // it. Join the canonical PID queue before removing the fixture's Home.
      await clearSessionMarkerConnectedServiceRestartIntent(h.tracked.pid);
    }
    if (disposition !== 'definite' && disposition !== 'continuation') expect(reports).toEqual([]);
    if (disposition === 'continuation-unavailable') {
      expect(diagnostics).toHaveBeenCalledWith('[DAEMON RUN] Continuation failure observation unavailable',
        expect.objectContaining({ phase: 'pending_activation_failure', exitCode: 78,
          // The requester owner retires authority after the failed Home read;
          // its final currentness error has no allowlisted platform code.
          errorClass: 'Error', errorCode: null }));
      const projection = diagnostics.mock.calls.filter(([message]) => message === '[DAEMON RUN] Continuation failure observation unavailable');
      expect(JSON.stringify(projection)).not.toContain('private-response');
    }
    expect(JSON.stringify(reports)).not.toContain('private-reference');
  },
);
