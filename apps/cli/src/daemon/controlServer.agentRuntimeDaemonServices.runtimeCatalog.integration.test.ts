import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import {
  AGENT_RUNTIME_DAEMON_SERVICES_PATH,
  AgentRuntimeDaemonServiceRequestV1Schema,
  AgentRuntimeDaemonServiceResponseV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
  createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createDaemonControlApp, type AgentRuntimeDaemonServiceRoutes } from './controlServer';
import {
  createAgentRuntimeDaemonServiceAuthorityPath,
  hashAgentRuntimeSessionBridgeToken,
  publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned,
} from './agentRuntime/sessionBridgeAuthorization';
import type { TrackedSession } from './types';
import { clearTrackedRunnerAgentDaemonServiceAdmission } from './agentRuntime/clearTrackedRunnerAgentDaemonServiceAdmission';
import { createDaemonAdmissionDrain } from './lifecycle/admissionDrain';
import { buildCgroupSelfMigratingHappyCliLaunchSpec } from './platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { sessionScopeExitEvidencePath } from './platform/linux/systemdUserResourceGovernor';
import { adoptTrackedSessionRunnerIdentity } from './sessions/sessionReportCorrelation';
import { readProcessIdentityByPid } from './processIdentity';
import { hashProcessCommand } from './sessionRegistry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { authorizeSessionModelTransitionProviderTargetWithLease } from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

type RecordAdmission = NonNullable<
  Parameters<typeof createDaemonControlApp>[0][
    'recordAgentRuntimeDaemonServiceAdmission'
  ]
>;
type RecordedAdmission = Parameters<RecordAdmission>[1];

const capabilityA = 'A'.repeat(43);
const capabilityB = 'B'.repeat(43);

function createRetainedAgent() {
  return createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'acme.plugin',
    pluginVersion: '1.2.3',
    agentId: 'acme-agent',
    localAgentId: 'acme-agent',
    sourceCustody: {
      kind: 'managed',
      immutableGenerationId: `sha256:${'1'.repeat(64)}`,
      installSource: 'npm',
    },
    locator: {
      module: './runtime.mjs',
      export: 'createRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: '/immutable/acme/runtime.mjs',
    loadMode: 'immutable-js',
  });
}

describe('daemon control server: runner-scoped Agent runtime services', () => {
  it('returns a real Provider authorization refusal through the strict model-transition service response', async () => {
    const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    const sessionId = 'session-provider-transition-refusal';
    const retainedAgent = createRetainedAgent();
    const runner = { pid: 2240, processStartTimeMs: 1_717_171_717_500,
      processCommandHash: 'f'.repeat(64), snapshotIdentity: 'snapshot:provider-transition' };
    const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing });
    const authority = await publishAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path: authorityPath, sessionId, runner, retainedAgent, httpPort: 46_007,
      capability: capabilityA, readPluginHardRevocationRevision: async () => 0 });
    const tracked: TrackedSession = {
      startedBy: 'daemon', pid: runner.pid, sessionRunnerPid: runner.pid, happySessionId: sessionId,
      processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
      agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
      agentRuntimeDaemonServiceCapabilityHash: authority.capabilityDigest,
      runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
      runnerAgentInvocationContext: { cwd: '/workspace', environment: {}, providerBindingActive: true },
    };
    const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_missing'), modelId: 'model' };
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'control-token',
      // Compose the production Provider producer, authority ingress and strict HTTP response.
      // No internal authorization, registry or error classifier is substituted.
      agentRuntimeDaemonServices: { dispatch: async () => {
        await authorizeSessionModelTransitionProviderTargetWithLease({
          sessionId, machineId: 'machine-1', agentId: 'codex', agentTargetKey: selection.agentTargetKey, lease,
          input: { selection, activeSelection: selection, activeSessionBindingMetadata: {
            v: 1, connectionId: selection.providerConnectionId, contributionKey: 'provider.test', connectionRevision: 1,
            model: { id: selection.modelId, name: selection.modelId }, protocol: 'openai-responses', materialization: 'engineConfig',
            compatibilityFingerprint: 'compatibility', bindingSecurityFingerprint: 'security',
            displaySnapshot: { providerName: 'Provider', connectionName: 'Provider', connectionRole: 'default', connectionDisplayNameMode: 'automatic' },
          } },
        });
        throw new Error('Expected the missing Account catalog to refuse authorization');
      } },
    });
    try {
      const response = await app.inject({ method: 'POST', url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: { 'x-happier-daemon-token': capabilityA }, payload: { v: 1,
          context: { token: capabilityA, sessionId },
          operation: { kind: 'model_transition.authorize', requestId: 'provider-refusal', selection } } });
      expect(response.statusCode).toBe(200);
      expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(response.json())).toEqual({
        ok: false, error: { code: 'provider_connection_not_found', message: 'provider_connection_not_found' },
      });
    } finally {
      await app.close();
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing, path: authorityPath, capabilityDigest: authority.capabilityDigest });
      await lease.release();
      await fixture.dispose();
    }
  });

  it.skipIf(process.platform !== 'linux')('authorizes the witnessed child of a real launch even when optional cgroup migration fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-runner-auth-'));
    const procfsRootDir = join(root, 'proc');
    const cgroupRootDir = join(root, 'cgroup');
    await mkdir(join(procfsRootDir, '111'), { recursive: true });
    await mkdir(cgroupRootDir);
    await writeFile(join(procfsRootDir, '111', 'cgroup'), '0::/user.slice/user-1000.slice/session-1.scope\n');
    // A non-delegated cgroup filesystem cannot create the sibling scope.
    await writeFile(join(cgroupRootDir, 'user.slice'), 'not delegated');
    const unit = `happier-session-${randomUUID().replaceAll('-', '')}.scope`;
    const spec = await buildCgroupSelfMigratingHappyCliLaunchSpec({
      daemonPid: 111, procfsRootDir, cgroupRootDir,
      unit,
      // systemd availability is an OS boundary; launch composition stays real.
      systemdUserResourceGovernorExecFile: async () => { throw new Error('No user manager'); },
      launchSpec: { runtime: 'node', filePath: process.execPath,
        args: ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'] },
    });
    if (!spec) throw new Error('Expected cgroup launch context');
    const child = spawn(spec.filePath, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    let app: ReturnType<typeof createDaemonControlApp> | undefined;
    let authority: Awaited<ReturnType<typeof publishAgentRuntimeDaemonServiceAuthority>> | undefined;
    let authorityPath: string | undefined;
    let runnerPid: number | undefined;
    try {
      const [line] = await Promise.race([once(lines, 'line'), closed.then(([code, signal]) => {
        throw new Error(`Launch exited before reporting its runner (exit=${String(code)}, signal=${String(signal)}): ${stderr.trim()}`);
      })]);
      runnerPid = Number(line);
      expect(runnerPid).not.toBe(child.pid);
      const wrapperFact = await readProcessIdentityByPid(child.pid!);
      const runnerFact = await readProcessIdentityByPid(runnerPid);
      if (typeof wrapperFact?.processStartTimeMs !== 'number' || typeof runnerFact?.processStartTimeMs !== 'number') {
        throw new Error('Expected live launch and runner process witnesses');
      }
      const wrapperIdentity = { pid: wrapperFact.pid, processStartTimeMs: wrapperFact.processStartTimeMs,
        processCommandHash: hashProcessCommand(wrapperFact.command) };
      const runnerIdentity = { pid: runnerFact.pid, processStartTimeMs: runnerFact.processStartTimeMs,
        processCommandHash: hashProcessCommand(runnerFact.command) };
      const sessionId = 'session-failed-cgroup-migration';
      const retainedAgent = createRetainedAgent();
      const tracked: TrackedSession = {
        startedBy: 'daemon', pid: wrapperIdentity.pid, happySessionId: sessionId,
        processStartTimeMs: wrapperIdentity.processStartTimeMs,
        processCommandHash: wrapperIdentity.processCommandHash,
        runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
        runnerAgentInvocationContext: Object.freeze({ cwd: root, environment: Object.freeze({}), providerBindingActive: false }),
      };
      adoptTrackedSessionRunnerIdentity(tracked, runnerIdentity);
      authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      });
      authority = await publishAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath, sessionId, runner: { pid: runnerIdentity.pid,
          processStartTimeMs: runnerIdentity.processStartTimeMs,
          processCommandHash: runnerIdentity.processCommandHash, snapshotIdentity: 'snapshot:failed-cgroup' },
        retainedAgent, httpPort: 46_006, capability: capabilityA, readPluginHardRevocationRevision: async () => 0,
      });
      tracked.agentRuntimeDaemonServiceAuthorityFilePath = authorityPath;
      tracked.agentRuntimeDaemonServiceCapabilityHash = authority.capabilityDigest;
      app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'machine-1',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'control-token' });
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
        context: { token: capabilityA, sessionId },
        operation: { kind: 'turn_contributions.resolve', requestId: 'runner-auth-request', request: { kind: 'prompt' } },
      });
      const send = () => app!.inject({ method: 'POST', url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: { 'x-happier-daemon-token': capabilityA }, payload: request });
      // Reaching the unavailable service proves real ingress admission without
      // substituting an internal dispatcher or bypassing marker verification.
      const admitted = await send();
      expect(admitted.statusCode).toBe(501);
      expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(admitted.json())).toMatchObject({
        ok: false, error: { code: 'agent_runtime_daemon_service_unavailable' },
      });
      const witnessedRunner = tracked.runnerProcessIdentity;
      // Missing adoption and a witness wired to the launcher must both stay forbidden.
      for (const misbound of [undefined, wrapperIdentity]) {
        tracked.runnerProcessIdentity = misbound;
        const refused = await send();
        expect(refused.statusCode).toBe(403);
        expect(AgentRuntimeDaemonServiceResponseV1Schema.parse(refused.json())).toMatchObject({
          ok: false, error: { code: 'agent_runtime_daemon_service_forbidden' },
        });
      }
      tracked.runnerProcessIdentity = witnessedRunner;
      expect((await send()).statusCode).toBe(501);
    } finally {
      lines.close();
      if (runnerPid && child.exitCode === null) process.kill(runnerPid, 'SIGTERM');
      else child.kill('SIGTERM');
      await closed;
      await app?.close();
      if (authority && authorityPath) await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath, capabilityDigest: authority.capabilityDigest,
      });
      await rm(root, { recursive: true, force: true });
      await rm(sessionScopeExitEvidencePath(configuration.activeServerDir, unit), { force: true });
    }
  });

  it('authorizes the current runner past a retained predecessor and parks new work while keeping accepted service reads open', async () => {
    const sessionId = 'session-drain-admission';
    const retainedAgent = createRetainedAgent();
    const runner = { pid: 2237, processStartTimeMs: 1_717_171_717_300,
      processCommandHash: 'd'.repeat(64), snapshotIdentity: 'snapshot:drain-admission' };
    const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing });
    const authority = await publishAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path: authorityPath, sessionId, runner, retainedAgent, httpPort: 46_004,
      capability: capabilityA, readPluginHardRevocationRevision: async () => 0 });
    const tracked: TrackedSession = {
      startedBy: 'daemon', pid: runner.pid, sessionRunnerPid: runner.pid, happySessionId: sessionId,
      processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
      agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
      agentRuntimeDaemonServiceCapabilityHash: authority.capabilityDigest,
      runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
      runnerAgentInvocationContext: Object.freeze({ cwd: '/workspace', environment: Object.freeze({}), providerBindingActive: false }),
    };
    // Exit cleanup may retain the old generation after the same Session starts
    // its queued input in a successor. Its different capability is not a veto.
    const predecessor: TrackedSession = {
      ...tracked,
      pid: runner.pid - 1,
      sessionRunnerPid: runner.pid - 1,
      agentRuntimeDaemonServiceCapabilityHash: hashAgentRuntimeSessionBridgeToken(capabilityB),
    };
    const admissionDrain = createDaemonAdmissionDrain();
    const app = createDaemonControlApp({ getChildren: () => [predecessor, tracked], machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'control-token', admissionDrain });
    const send = (operation: unknown) => app.inject({ method: 'POST', url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
      headers: { 'x-happier-daemon-token': capabilityA }, payload: { v: 1,
        context: { token: capabilityA, sessionId }, operation } });
    const turn = { kind: 'turn.admission.authorize', requestId: 'turn-request',
      witness: { turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1] } };
    const managedProcess = { kind: 'managed_server.supervision.authorize', requestId: 'spawn-request',
      contributionId: 'acme-agent', serverId: 'native-server', executable: { kind: 'systemTool', id: 'native-cli' }, environmentKeys: [] };
    try {
      const staleResponse = await app.inject({ method: 'POST', url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: { 'x-happier-daemon-token': capabilityB }, payload: { v: 1,
          context: { token: capabilityB, sessionId }, operation: turn } });
      expect(staleResponse.statusCode).toBe(403);
      // No internal dispatcher is substituted. The real private authority gets
      // through ingress to the unavailable-service boundary when admission is open.
      for (const operation of [turn, managedProcess]) expect((await send(operation)).statusCode).toBe(501);
      admissionDrain.beginTemporaryDrain();
      for (const operation of [turn, managedProcess]) expect((await send(operation)).statusCode).toBe(503);
      expect((await send({ kind: 'managed_server.endpoint.release', requestId: 'release-request',
        pluginId: retainedAgent.pluginId, instanceId: 'accepted-instance', projectionToken: 'b'.repeat(64) })).statusCode).toBe(501);
      admissionDrain.resume();
      for (const operation of [turn, managedProcess]) expect((await send(operation)).statusCode).toBe(501);
      admissionDrain.beginShutdown();
      admissionDrain.resume();
      expect((await send(turn)).statusCode).toBe(503);
    } finally {
      await app.close();
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing, path: authorityPath, capabilityDigest: authority.capabilityDigest });
    }
  });

  it('logs one local-only route diagnostic when daemon-service dispatch fails', async () => {
    const sessionId = 'session-dispatch-failure';
    const retainedAgent = createRetainedAgent();
    const runner = {
      pid: 2238,
      processStartTimeMs: 1_717_171_717_400,
      processCommandHash: 'e'.repeat(64),
      snapshotIdentity: 'snapshot:dispatch-failure',
    };
    const invocationContext = Object.freeze({
      cwd: '/workspace',
      environment: Object.freeze({}),
      providerBindingActive: false,
    });
    const dispatchFailure = new Error('daemon-service dispatch failed');
    const dispatch = vi.fn(async () => {
      throw dispatchFailure;
    });
    const warnLocalFile = vi.spyOn(logger, 'warnLocalFile')
      .mockImplementation(() => {});
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'control-token',
      agentRuntimeDaemonServices: { dispatch },
      foregroundAgentRuntimeAdmission: {
        authorizeDaemonServiceRequest: () => ({
          retainedAgent,
          runner,
          capabilityDigest:
            hashAgentRuntimeSessionBridgeToken(capabilityA),
          invocationContext,
          readAdmission: () => null,
          recordAdmission: async () => false,
        }),
      } as never,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: { 'x-happier-daemon-token': capabilityA },
        payload: {
          v: 1,
          context: { token: capabilityA, sessionId },
          operation: {
            kind: 'plugin_services.subscription.next_v1',
            requestId: 'request-dispatch-failure',
            invocationId: 'invocation-1',
            subscriptionId: 'subscription-1',
          },
        },
      });

      expect(response.statusCode).toBe(500);
      expect(dispatch).toHaveBeenCalledOnce();
      const failureLogs = warnLocalFile.mock.calls.filter(
        ([message]) => message
          === '[CONTROL SERVER] Agent runtime daemon service request failed',
      );
      expect(failureLogs).toEqual([[
        '[CONTROL SERVER] Agent runtime daemon service request failed',
        {
          route: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
          sessionId,
          error: dispatchFailure,
        },
      ]]);
      expect(JSON.stringify(warnLocalFile.mock.calls))
        .not.toContain(capabilityA);
    } finally {
      warnLocalFile.mockRestore();
      await app.close();
    }
  });

  it.each([
    ['retained Agent', 'acme.plugin', 'before'],
    ['retained Agent', 'acme.plugin', 'during'],
    ['adopted Provider', 'acme.provider', 'before'],
    ['adopted Provider', 'acme.provider', 'during'],
  ] as const)(
    'refuses turn admission when the current hard-revocation revision advances for the %s %s dispatch',
    async (_label, revokedPluginId, revocationPhase) => {
      const sessionId = `session-revocation-${revokedPluginId}`;
      const retainedAgent = createRetainedAgent();
      const runner = {
        pid: revokedPluginId === 'acme.plugin' ? 2234 : 2235,
        processStartTimeMs: 1_717_171_717_100,
        processCommandHash: 'b'.repeat(64),
        snapshotIdentity: `snapshot:${revokedPluginId}`,
      };
      const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
      });
      const currentRevisions = new Map<string, number>([
        [retainedAgent.pluginId, 7],
        ['acme.provider', 11],
      ]);
      const authority = await publishAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath,
        sessionId,
        runner,
        retainedAgent,
        httpPort: 46_002,
        capability: capabilityA,
        expectedPluginHardRevocationRevision: 7,
        readPluginHardRevocationRevision: async (pluginId) =>
          currentRevisions.get(pluginId) ?? 0,
      });
      if (revocationPhase === 'before') {
        currentRevisions.set(
          revokedPluginId,
          (currentRevisions.get(revokedPluginId) ?? 0) + 1,
        );
      }
      const tracked: TrackedSession = {
        startedBy: 'daemon',
        pid: runner.pid,
        sessionRunnerPid: runner.pid,
        happySessionId: sessionId,
        processStartTimeMs: runner.processStartTimeMs,
        processCommandHash: runner.processCommandHash,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
        agentRuntimeDaemonServiceCapabilityHash: authority.capabilityDigest,
        runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
        runnerAgentInvocationContext: Object.freeze({
          cwd: '/workspace',
          environment: Object.freeze({}),
          providerBindingActive: true,
        }),
        runnerManagedDependencyRetentionV1: {
          v: 1,
          adoptedManagedProviderAuthority: {
            pluginId: 'acme.provider',
            sourceCustody: {
              kind: 'managed',
              immutableGenerationId: 'provider-generation',
              installSource: 'npm',
            },
            manifestAuthority: 'external',
            hardRevocationRevisionAtAdmission: 11,
          },
          sourceCustodies: [],
          qualifiedDependencyIds: [],
        },
      };
      const dispatch = vi.fn(async (request: { operation: { kind: string } }) => {
        if (revocationPhase === 'during') {
          currentRevisions.set(
            revokedPluginId,
            (currentRevisions.get(revokedPluginId) ?? 0) + 1,
          );
        }
        return {
          ok: true as const,
          result: {
            kind: 'turn.admission' as const,
            status: 'admitted' as const,
            witness: {
              turnId: 'turn-revoked',
              inputId: 'input-revoked',
              userMessageSeq: 8,
              userMessageSeqs: [8],
            },
          },
        };
      });
      const recordAdmission = vi.fn<RecordAdmission>(async () => true);
      const app = createDaemonControlApp({
        getChildren: () => [tracked],
        machineId: 'machine-1',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        requestShutdown: () => {},
        onHappySessionWebhook: () => {},
        controlToken: 'control-token',
        agentRuntimeDaemonServices: { dispatch },
        recordAgentRuntimeDaemonServiceAdmission: recordAdmission,
        readPluginHardRevocationRevision: async (pluginId) =>
          currentRevisions.get(pluginId) ?? 0,
      });

      try {
        const response = await app.inject({
          method: 'POST',
          url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
          headers: { 'x-happier-daemon-token': capabilityA },
          payload: {
            v: 1,
            context: { token: capabilityA, sessionId },
            operation: {
              kind: 'turn.admission.authorize',
              requestId: 'request-revoked',
              witness: {
                turnId: 'turn-revoked',
                inputId: 'input-revoked',
                userMessageSeq: 8,
                userMessageSeqs: [8],
              },
            },
          },
        });

        expect(response.statusCode).toBe(revocationPhase === 'before' ? 403 : 503);
        expect(recordAdmission).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledTimes(
          revocationPhase === 'during' ? 1 : 0,
        );
      } finally {
        await app.close();
        await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
          happyHomeDir: configuration.happyHomeDir,
          publicReleaseRing: configuration.publicReleaseRing,
          path: authorityPath,
          capabilityDigest: authority.capabilityDigest,
        });
      }
    },
  );

  it('refuses a non-admission effect result when adopted Provider authority is replaced during dispatch', async () => {
    const sessionId = 'session-secret-revocation';
    const retainedAgent = createRetainedAgent();
    const runner = {
      pid: 2236,
      processStartTimeMs: 1_717_171_717_200,
      processCommandHash: 'c'.repeat(64),
      snapshotIdentity: 'snapshot:secret-revocation',
    };
    const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: configuration.happyHomeDir,
      publicReleaseRing: configuration.publicReleaseRing,
    });
    const currentRevisions = new Map<string, number>([
      [retainedAgent.pluginId, 7],
      ['acme.provider', 11],
      ['acme.provider.next', 19],
    ]);
    const authority = await publishAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: configuration.happyHomeDir,
      publicReleaseRing: configuration.publicReleaseRing,
      path: authorityPath,
      sessionId,
      runner,
      retainedAgent,
      httpPort: 46_003,
      capability: capabilityA,
      expectedPluginHardRevocationRevision: 7,
      readPluginHardRevocationRevision: async (pluginId) =>
        currentRevisions.get(pluginId) ?? 0,
    });
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: runner.pid,
      sessionRunnerPid: runner.pid,
      happySessionId: sessionId,
      processStartTimeMs: runner.processStartTimeMs,
      processCommandHash: runner.processCommandHash,
      agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
      agentRuntimeDaemonServiceCapabilityHash: authority.capabilityDigest,
      runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
      runnerAgentInvocationContext: Object.freeze({
        cwd: '/workspace',
        environment: Object.freeze({}),
        providerBindingActive: true,
      }),
      runnerManagedDependencyRetentionV1: {
        v: 1,
        adoptedManagedProviderAuthority: {
          pluginId: 'acme.provider',
          sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'provider-generation',
            installSource: 'npm',
          },
          manifestAuthority: 'external',
          hardRevocationRevisionAtAdmission: 11,
        },
        sourceCustodies: [],
        qualifiedDependencyIds: [],
      },
    };
    const dispatch = vi.fn(async () => {
      tracked.runnerManagedDependencyRetentionV1 = {
        v: 1,
        adoptedManagedProviderAuthority: {
          pluginId: 'acme.provider.next',
          sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'provider-generation-next',
            installSource: 'npm',
          },
          manifestAuthority: 'external',
          hardRevocationRevisionAtAdmission: 19,
        },
        sourceCustodies: [],
        qualifiedDependencyIds: [],
      };
      return {
        ok: true as const,
        result: {
          kind: 'managed_server.secret' as const,
          status: 'resolved' as const,
          requestId: 'request-secret-revoked',
          value: 'must-not-escape',
          revision: 'revision-1',
        },
      };
    });
    const app = createDaemonControlApp({
      getChildren: () => [tracked],
      machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'control-token',
      agentRuntimeDaemonServices: { dispatch },
      readPluginHardRevocationRevision: async (pluginId) =>
        currentRevisions.get(pluginId) ?? 0,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: { 'x-happier-daemon-token': capabilityA },
        payload: {
          v: 1,
          context: { token: capabilityA, sessionId },
          operation: {
            kind: 'managed_server.secret.read',
            requestId: 'request-secret-revoked',
            phase: 'read',
            secretId: 'provider-api-key',
            canonicalOrigin: 'https://provider.example',
          },
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('must-not-escape');
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath,
        capabilityDigest: authority.capabilityDigest,
      });
    }
  });

  it('authorizes direct retained-runner custody with a rotated capability and exact turn witness', async () => {
    const sessionId = 'session-1';
    const retainedAgent = createRetainedAgent();
    const runner = {
      pid: 1234,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: 'a'.repeat(64),
      snapshotIdentity: 'snapshot:runner-a',
    };
    const authorityPath =
      await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
      });
    const publishAuthority = async (capability: string) =>
      await publishAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath,
        sessionId,
        runner,
        retainedAgent,
        httpPort: 46_001,
        capability,
        readPluginHardRevocationRevision: async () => 0,
      });
    let authority = await publishAuthority(capabilityA);
    const invocationContext = Object.freeze({
      cwd: '/workspace',
      environment: Object.freeze({}),
      providerBindingActive: false,
    });
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: runner.pid,
      sessionRunnerPid: runner.pid,
      happySessionId: sessionId,
      processStartTimeMs: runner.processStartTimeMs,
      processCommandHash: runner.processCommandHash,
      agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
      agentRuntimeDaemonServiceCapabilityHash:
        authority.capabilityDigest,
      runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
      runnerAgentInvocationContext: invocationContext,
    };
    let actionIsCurrent: (() => Promise<boolean>) | undefined;
    const dispatch = vi.fn(async (
      request: { operation: { kind: string } },
      context: Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[1],
    ) => request.operation.kind === 'turn.admission.authorize'
      ? {
          ok: true as const,
          result: {
            kind: 'turn.admission' as const,
            status: 'admitted' as const,
            witness: {
              turnId: 'turn-1',
              inputId: 'input-1',
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
          },
        }
      : request.operation.kind === 'session.open.attest'
        ? {
            ok: true as const,
            result: {
              kind: 'session.open.attestation' as const,
              status: 'recorded' as const,
            },
          }
        : request.operation.kind === 'action.execute'
          ? (() => {
              actionIsCurrent = context.isCurrent;
              return {
                ok: true as const,
                result: {
                  kind: 'action.execution' as const,
                  requestId: 'action-1',
                  outcome: { ok: true as const, result: { triggers: [] } },
                },
              };
            })()
        : {
            ok: true as const,
            result: {
              kind: 'managed_server.endpoint' as const,
              status: 'unavailable' as const,
            },
          });
    const authorizeForegroundDaemonServiceRequest = vi.fn(() => null);
    const recordAdmission = vi.fn<RecordAdmission>(async () => true);
    const clearAdmission = vi.fn<NonNullable<
      Parameters<typeof createDaemonControlApp>[0][
        'clearAgentRuntimeDaemonServiceAdmission'
      ]
    >>(async () => true);
    // Session RPC is a process boundary. Its live Run owner, not the parent
    // foreground admission, answers for this independently admitted child.
    let childCurrent = true;
    const app = createDaemonControlApp({
      getChildren: () => [tracked],
      machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'control-token',
      agentRuntimeDaemonServices: { dispatch,
        authorizeExecutionRunAction: async (request, context) => childCurrent
          && context.trackedSession === tracked
          && request.executionRun?.runId === 'child-run'
          && request.executionRun.occurrenceId === 'child-occurrence'
          && request.witness.turnId === 'child-turn',
      },
      foregroundAgentRuntimeAdmission: {
        authorizeDaemonServiceRequest:
          authorizeForegroundDaemonServiceRequest,
      } as never,
      recordAgentRuntimeDaemonServiceAdmission:
        recordAdmission,
      clearAgentRuntimeDaemonServiceAdmission:
        clearAdmission,
    });
    const send = async (header: string, token = header) =>
      await app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: { 'x-happier-daemon-token': header },
        payload: {
          v: 1,
          context: {
            token,
            sessionId,
          },
          operation: {
            kind: 'turn.admission.authorize',
            requestId: 'request-1',
            witness: {
              turnId: 'turn-1',
              inputId: 'input-1',
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
          },
        },
      });
    const resolveEndpoint = async (
      inputId: string,
      token = capabilityB,
    ) =>
      await app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: {
          'x-happier-daemon-token': token,
        },
        payload: {
          v: 1,
          context: {
            token,
            sessionId,
          },
          operation: {
            kind: 'managed_server.endpoint.resolve',
            requestId: 'resolve-1',
            witness: {
              turnId: 'turn-1',
              inputId,
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
            selector: {
              kind: 'projectionToken',
              projectionToken: 'b'.repeat(64),
            },
          },
        },
      });
    const attestSessionOpen = async () =>
      await app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: {
          'x-happier-daemon-token': capabilityB,
        },
        payload: {
          v: 1,
          context: {
            token: capabilityB,
            sessionId,
          },
          operation: {
            kind: 'session.open.attest',
            requestId: 'attest-open-1',
            request: {
              kind: 'resume',
              sessionId,
              cwd: '/workspace',
              providerSessionId: 'provider-1',
            },
            providerSessionId: 'provider-1',
          },
        },
      });
    const executeAction = async (
      inputId: string,
      options: { token?: string; sessionId?: string; extra?: Record<string, unknown> } = {},
    ) => app.inject({
      method: 'POST',
      url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
      headers: { 'x-happier-daemon-token': options.token ?? capabilityB },
      payload: {
        v: 1,
        context: { token: options.token ?? capabilityB, sessionId: options.sessionId ?? sessionId },
        operation: {
          kind: 'action.execute',
          requestId: 'action-1',
          actionId: 'workflow.trigger.list',
          input: { workflowDefinitionId: 'workflow-1' },
          toolCallId: 'tool-call-1',
          witness: { turnId: 'turn-1', inputId, userMessageSeq: 7, userMessageSeqs: [7] },
          ...options.extra,
        },
      },
    });

    try {
      await app.ready();
      Object.assign(tracked, {
        activeTurnId: 'turn-1',
        reattachedInterruptedTurnId: 'turn-1',
      });
      expect(
        (await resolveEndpoint('input-1', capabilityA)).statusCode,
      ).toBe(403);
      delete (tracked as { activeTurnId?: string }).activeTurnId;
      delete (tracked as { reattachedInterruptedTurnId?: string })
        .reattachedInterruptedTurnId;

      expect((await send('control-token', capabilityA)).statusCode)
        .toBe(403);
      expect((await send(capabilityB)).statusCode).toBe(403);
      expect(authorizeForegroundDaemonServiceRequest)
        .not.toHaveBeenCalled();

      expect((await send(capabilityA)).statusCode).toBe(200);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            witness: {
              turnId: 'turn-1',
              inputId: 'input-1',
              userMessageSeq: 7,
              userMessageSeqs: [7],
            },
          }),
        }),
        expect.objectContaining({
          sessionId,
          runner,
          retainedAgent,
          invocationContext,
          trackedSession: tracked,
        }),
      );
      expect(Object.keys(dispatch.mock.calls[0]?.[1] ?? {}).sort())
        .toEqual([
          'invocationContext',
          'isCurrent',
          'retainedAgent',
          'runner',
          'sessionId',
          'signal',
          'trackedSession',
        ]);

      authority = await publishAuthority(capabilityB);
      // The private authority document rotated before tracked custody did, so
      // neither the stale capability nor the not-yet-projected replacement can
      // reach dispatch during that handoff window.
      expect((await send(capabilityA)).statusCode).toBe(403);
      expect((await send(capabilityB)).statusCode).toBe(403);
      expect(dispatch).toHaveBeenCalledTimes(1);
      tracked.agentRuntimeDaemonServiceCapabilityHash =
        authority.capabilityDigest;
      expect((await send(capabilityA)).statusCode).toBe(403);
      expect((await send(capabilityB)).statusCode).toBe(200);
      expect((await attestSessionOpen()).statusCode).toBe(200);
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            kind: 'session.open.attest',
          }),
        }),
        expect.objectContaining({
          sessionId,
          runner,
          retainedAgent,
          invocationContext,
          trackedSession: tracked,
        }),
      );

      expect(
        (await resolveEndpoint('foreign-input')).statusCode,
      ).toBe(403);
      tracked.runnerAgentSourceCustodyV1 = {
        kind: 'managed',
        immutableGenerationId: 'forged-generation',
        installSource: 'npm',
      };
      expect(
        (await resolveEndpoint('input-1')).statusCode,
      ).toBe(403);
      tracked.runnerAgentSourceCustodyV1 = retainedAgent.sourceCustody;
      tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs = [8];
      expect(
        (await resolveEndpoint('input-1')).statusCode,
      ).toBe(403);
      tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs = [7];
      expect(
        (await resolveEndpoint('input-1')).statusCode,
      ).toBe(200);

      const actionResponse = await executeAction('input-1');
      expect(actionResponse.statusCode).toBe(200);
      expect(actionResponse.json()).toEqual({
        ok: true,
        result: { kind: 'action.execution', requestId: 'action-1', outcome: { ok: true, result: { triggers: [] } } },
      });
      expect(await actionIsCurrent?.()).toBe(true);
      tracked.agentRuntimeDaemonServiceAdmittedInputId = 'next-input';
      // Already-admitted work keeps runner custody; changing the active turn
      // only prevents admission of another request with the old witness.
      expect(await actionIsCurrent?.()).toBe(true);
      expect((await executeAction('input-1')).statusCode).toBe(403);
      tracked.agentRuntimeDaemonServiceAdmittedInputId = 'input-1';
      expect((await executeAction('input-1', { sessionId: 'foreign-session' })).statusCode).toBe(403);
      expect((await executeAction('input-1', { token: capabilityA })).statusCode).toBe(403);
      expect((await executeAction('input-1', { extra: {
        witness: {
          turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 7, userMessageSeqs: [7],
          agentStartCaller: { kind: 'session', sessionId: 'foreign-session', starterDepth: 0, turnDepth: 1 },
          workDepth: 1,
        },
      } })).statusCode).toBe(403);
      expect((await executeAction('input-1', { extra: { caller: { kind: 'host' } } })).statusCode).toBe(400);
      expect((await executeAction('input-1', { extra: { callerPermissionMode: 'yolo' } })).statusCode).toBe(400);

      const childAction = (occurrenceId = 'child-occurrence') => executeAction('child-input', { extra: {
        executionRun: { runId: 'child-run', occurrenceId },
        witness: { turnId: 'child-turn', inputId: 'child-input', userMessageSeq: null, userMessageSeqs: [],
          agentStartCaller: { kind: 'session', sessionId, starterDepth: 1, turnDepth: 1 }, workDepth: 1 },
      } });
      expect((await childAction()).statusCode).toBe(200);
      expect(await actionIsCurrent?.()).toBe(true);
      expect((await childAction('replaced-occurrence')).statusCode).toBe(403);
      childCurrent = false;
      expect((await childAction()).statusCode).toBe(403);

      let markerAdmission: RecordedAdmission | null = null;
      let resolveRecordEntered: (() => void) | undefined;
      const recordEntered = new Promise<void>((resolve) => {
        resolveRecordEntered = resolve;
      });
      let resumeRecord: (() => void) | undefined;
      const recordGate = new Promise<void>((resolve) => {
        resumeRecord = resolve;
      });
      recordAdmission.mockImplementationOnce(
        async (_tracked, admission) => {
          resolveRecordEntered?.();
          await recordGate;
          markerAdmission = admission;
          return true;
        },
      );
      clearAdmission.mockImplementationOnce(
        async (_tracked, admission) => {
          if (
            markerAdmission
            && JSON.stringify(markerAdmission)
              === JSON.stringify(admission)
          ) {
            markerAdmission = null;
          }
          return true;
        },
      );

      const racedAdmission = send(capabilityB);
      await recordEntered;

      // Mirror the existing synchronous hard-revocation mutation while its
      // marker cleanup and runner termination continue asynchronously.
      tracked.agentRuntimeRunnerRestartDisposition =
        'runner_authority_unavailable';
      delete tracked.agentRuntimeDaemonServiceCapabilityHash;
      clearTrackedRunnerAgentDaemonServiceAdmission(tracked);

      resumeRecord?.();
      const racedResponse = await racedAdmission;
      expect(racedResponse.statusCode).toBe(503);
      expect(racedResponse.json()).toEqual({
        ok: false,
        error: {
          code:
            'agent_runtime_daemon_service_admission_custody_unavailable',
          message:
            'Agent runtime daemon service admission custody is unavailable',
        },
      });
      expect(markerAdmission).toBeNull();
      expect(clearAdmission).toHaveBeenCalledWith(
        tracked,
        {
          turnId: 'turn-1',
          inputId: 'input-1',
          userMessageSeq: 7,
          userMessageSeqs: [7],
        },
      );
      expect(tracked.agentRuntimeDaemonServiceAdmittedTurnId)
        .toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedInputId)
        .toBeUndefined();

      const dispatchCountAfterRevocation = dispatch.mock.calls.length;
      expect((await send(capabilityB)).statusCode).toBe(403);
      expect(dispatch).toHaveBeenCalledTimes(
        dispatchCountAfterRevocation,
      );
    } finally {
      await app.close();
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath,
        capabilityDigest: authority.capabilityDigest,
      });
    }
  });

  it('uses the foreground owner as the exact direct-custody and admission subject after V2 claim', async () => {
    const sessionId = 'session-foreground';
    const retainedAgent = createRetainedAgent();
    const runner = {
      pid: 4321,
      processStartTimeMs: 1_717_171_717_000,
      processCommandHash: 'a'.repeat(64),
      snapshotIdentity: 'snapshot:foreground',
    };
    const invocationContext = Object.freeze({
      cwd: '/workspace',
      environment: Object.freeze({}),
      providerBindingActive: false,
    });
    let admission: RecordedAdmission | null = null;
    const recordAdmission = vi.fn(async (next: RecordedAdmission) => {
      admission = next;
      return true;
    });
    const authorizeDaemonServiceRequest = vi.fn(
      ({ providedCapability }: { providedCapability: string }) =>
        providedCapability === 'F'.repeat(43)
          ? {
              retainedAgent,
              runner,
              capabilityDigest:
                hashAgentRuntimeSessionBridgeToken('F'.repeat(43)),
              invocationContext,
              readAdmission: () => admission,
              recordAdmission,
            }
          : null,
    );
    let actionIsCurrent: (() => Promise<boolean>) | undefined;
    const dispatch = vi.fn(async (
      request: { operation: { kind: string } },
      context: Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[1],
    ) => request.operation.kind === 'action.execute'
      ? (() => {
          actionIsCurrent = context.isCurrent;
          return {
            ok: true as const,
            result: {
              kind: 'action.execution' as const,
              requestId: 'action-foreground',
              outcome: { ok: true as const, result: { sent: true } },
            },
          };
        })()
      : ({
      ok: true as const,
      result: {
        kind: 'turn.admission' as const,
        status: 'admitted' as const,
        witness: {
          turnId: 'turn-foreground',
          inputId: 'input-foreground',
          userMessageSeq: 9,
          userMessageSeqs: [9],
        },
      },
    }));
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({
        type: 'success',
        sessionId: 'unused',
      }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'control-token',
      agentRuntimeDaemonServices: { dispatch },
      foregroundAgentRuntimeAdmission: {
        authorizeDaemonServiceRequest,
      } as never,
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: {
          'x-happier-daemon-token': 'F'.repeat(43),
        },
        payload: {
          v: 1,
          context: {
            token: 'F'.repeat(43),
            sessionId,
          },
          operation: {
            kind: 'turn.admission.authorize',
            requestId: 'request-foreground',
            witness: {
              turnId: 'turn-foreground',
              inputId: 'input-foreground',
              userMessageSeq: 9,
              userMessageSeqs: [9],
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(authorizeDaemonServiceRequest)
        .toHaveBeenCalledOnce();
      expect(recordAdmission).toHaveBeenCalledWith({
        turnId: 'turn-foreground',
        inputId: 'input-foreground',
        userMessageSeq: 9,
        userMessageSeqs: [9],
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sessionId,
          runner,
          retainedAgent,
          invocationContext,
        }),
      );
      expect(Object.keys(dispatch.mock.calls[0]?.[1] ?? {}).sort())
        .toEqual([
          'invocationContext',
          'isCurrent',
          'retainedAgent',
          'runner',
          'sessionId',
          'signal',
        ]);
      const executeAction = (inputId = 'input-foreground') => app.inject({
        method: 'POST',
        url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: { 'x-happier-daemon-token': 'F'.repeat(43) },
        payload: {
          v: 1,
          context: { token: 'F'.repeat(43), sessionId },
          operation: {
            kind: 'action.execute',
            requestId: 'action-foreground',
            actionId: 'notifications.notify_me',
            input: { message: 'Done' },
            witness: { turnId: 'turn-foreground', inputId, userMessageSeq: 9, userMessageSeqs: [9] },
          },
        },
      });
      expect((await executeAction()).statusCode).toBe(200);
      expect(await actionIsCurrent?.()).toBe(true);
      expect((await executeAction('foreign-input')).statusCode).toBe(403);
      admission = null;
      expect(await actionIsCurrent?.()).toBe(true);
      expect((await executeAction()).statusCode).toBe(403);
      authorizeDaemonServiceRequest.mockReturnValue(null);
      expect(await actionIsCurrent?.()).toBe(false);
    } finally {
      await app.close();
    }
  });
});
