import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { projectCurrentAgentSessionView } from '@happier-dev/agents';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { awaitTrackedRunnerAgentSessionOpen, recordTrackedRunnerAgentSessionOpenAttestation } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { createStopSession } from '@/daemon/sessions/stopSession';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { TrackedSession } from '@/daemon/types';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { createMachineSessionSpawnRpcHandler } from '../sessionLifecycleActions';

import { createSpawnNewSessionLifecycleActionHandler } from './createSpawnNewSessionLifecycleActionHandler';
import { runRequesterSessionLifecycle } from './requesterSessionLifecycle';
import { attemptNativeForkOpen } from './fork/attemptNativeForkOpen';

describe('Session startup operation custody', () => {
  it.each(['current', 'replacement', 'changed-birth', 'stop-throws', 'stop-incomplete'] as const)(
    'retires only the attested refused generation and preserves its typed failure (%s)', async scenario => {
    const sessionId = 'refused-child';
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'refused-startup', supportsCoreCancellation: () => true });
    const scope = { machineId: 'machine', accountId: 'account' };
    const binding = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.plugin', pluginVersion: '1.0.0',
      agentId: 'acme-agent', localAgentId: 'acme-agent', sourceCustody: { kind: 'managed',
        immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js' });
    const runner = { pid: 41001001, processStartTimeMs: 1000, processCommandHash: 'a'.repeat(64) };
    const refused: TrackedSession = { ...runner, startedBy: 'daemon', happySessionId: sessionId,
      runnerAgentSourceCustodyV1: binding.sourceCustody,
      agentRuntimeDaemonServiceAuthorityFilePath: '/fixture/refused-authority' };
    const replacement: TrackedSession = { pid: 41001002, processStartTimeMs: 2000, startedBy: 'daemon',
      happySessionId: sessionId, agentRuntimeDaemonServiceAuthorityFilePath: '/fixture/replacement-authority' };
    const tracked = new Map([[refused.pid, refused]]);
    const selected: number[][] = [];
    const retired: number[] = [];
    const physical = createStopSession({ pidToTrackedSession: tracked,
      // OS liveness/exit and terminal files are boundaries; no actual PID is signalled.
      areTrackedRunnersExited: async ({ trackedPids }) => { selected.push([...trackedPids]); return true; },
      waitForTrackedRunnersExit: async ({ trackedPids }) => {
        expect(operations.store.get(scope, 'refused-startup')).toMatchObject({ state: 'running' });
        retired.push(...trackedPids);
        return true;
      },
      readHostAttachmentState: async () => ({ status: 'absent' }), readTerminalAttachmentInfo: async () => null,
    });
    const handler = createMachineSessionSpawnRpcHandler({ handlers: {
      spawnSession: async () => {
        // External Agent producer -> exact private parser -> host recorder -> waiter.
        const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
          context: { token: 'a'.repeat(43), sessionId }, operation: { kind: 'session.open.attest',
            requestId: 'refused-open', phase: 'refused', request: { kind: 'create', sessionId, cwd: '/project' },
            providerSessionId: null } });
        if (request.operation.kind !== 'session.open.attest') throw new Error('Wrong attestation operation');
        expect(await recordTrackedRunnerAgentSessionOpenAttestation({ tracked: refused, retainedAgent: binding, runner,
          ...request.operation, updateMarker: async () => true })).not.toBeNull();
        return { type: 'success', sessionId };
      },
      stopSession: scenario === 'stop-throws' ? async () => { throw new Error('OS Stop failed'); }
        : scenario === 'stop-incomplete' ? async () => ({ status: 'incomplete', reason: 'runner_signal_incomplete' })
        : physical,
    }, awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ ...input, getTrackedSessions: () => {
      const rows = [...tracked.values()];
      // Replacement registration or a mis-bound mutable birth occurs after observation, before Stop selection.
      if (scenario === 'replacement') queueMicrotask(() => { tracked.clear(); tracked.set(replacement.pid, replacement); });
      if (scenario === 'changed-birth') queueMicrotask(() => { refused.processStartTimeMs = 2000; });
      return rows;
    } }) });
    try {
      await operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'refused' },
        execute: async operation => ({ ok: true, result: await handler({ directory: '/project',
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        }, { signal: operation.signal, localActionContext: operation }) }) });
      await operations.handlers.getV2({ operationId: 'refused-startup', waitForTerminal: true });
      expect(operations.store.get(scope, 'refused-startup')).toMatchObject({ state: 'failed',
        error: { errorCode: 'native_agent_session_mode_unavailable' } });
      expect(retired).toEqual(scenario === 'current' ? [refused.pid] : []);
      expect(selected).toEqual(scenario === 'current' ? [[refused.pid]] : []);
      expect(replacement.stopRequestedAtMs).toBeUndefined();
      if (scenario !== 'current') expect(refused.stopRequestedAtMs).toBeUndefined();
      else expect(refused.stopRequestedAtMs).toBeTypeOf('number');
    } finally { operations.runner.cancel(scope, 'refused-startup'); }
  });

  it('joins refused-child retirement before failing the original startup operation', async () => {
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'refused-startup', supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { pid: 103, startedBy: 'daemon', happySessionId: 'refused-child',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/refused-authority.json',
      agentRuntimeDaemonServiceSessionOpenAttestation: AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema.parse({
        request: { kind: 'create', sessionId: 'refused-child', cwd: '/project' }, providerSessionId: null,
        refusal: { code: 'native_agent_session_mode_unavailable' },
      }) };
    let releaseStop!: () => void;
    const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
    let stopEntered!: () => void;
    const stopping = new Promise<void>(resolve => { stopEntered = resolve; });
    const handler = createMachineSessionSpawnRpcHandler({ handlers: {
      spawnSession: async () => ({ type: 'success', sessionId: 'refused-child' }),
      // The process adapter acknowledges only after the exact child exits.
      stopSession: async sessionId => {
        expect(sessionId).toBe('refused-child'); stopEntered(); await stopped;
        return { status: 'stopped' };
      },
    }, awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], ...input }) });
    const scope = { accountId: 'account', machineId: 'machine' };
    const response = operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'refused' },
      execute: async operation => ({ ok: true, result: await handler({ directory: '/project',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      }, { signal: operation.signal, localActionContext: operation }) }) });
    try {
      await response;
      await vi.waitFor(() => expect(operations.store.get(scope, 'refused-startup')).toMatchObject({ state: 'running' }));
      await Promise.race([stopping, operations.handlers.getV2({ operationId: 'refused-startup', waitForTerminal: true }).then(() => {
        throw new Error('Startup settled without retiring its refused runner');
      })]);
      expect(operations.store.get(scope, 'refused-startup')).toMatchObject({ state: 'running' });
      releaseStop();
      await vi.waitFor(() => expect(operations.store.get(scope, 'refused-startup')).toMatchObject({ state: 'failed',
        error: { errorCode: 'native_agent_session_mode_unavailable' } }));
    } finally { releaseStop(); operations.runner.cancel(scope, 'refused-startup'); }
  });
  it.each(['refused', 'runner_exited'] as const)('keeps native-fork %s cleanup inside its own open owner after requester startup', async outcome => {
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'native-fork-startup', supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { pid: 102, startedBy: 'daemon', happySessionId: 'native-fork-child',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/native-fork-authority.json' };
    const runtimeDescriptorV1 = { v: 1 as const, agentId: 'acme-agent', agent: { providerSessionId: 'provider-parent' } };
    const parentMetadata = projectCurrentAgentSessionView({ runtimeDescriptorV1 }, { agentId: 'acme-agent',
      runtimeDescriptor: runtimeDescriptorV1, nativeResumeIdentity: { v: 1, vendorResumeId: 'provider-parent' } });
    let stopped = false;
    let archived = false;
    const child = createSessionRecordFixture({ id: 'native-fork-child', active: true, machineId: null });
    // Home HTTP and physical runner launch/Stop are system boundaries; startup,
    // native-fork admission, marker interpretation and cleanup remain real.
    const home = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === '/v2/sessions/native-fork-child') {
        response.end(JSON.stringify({ session: { ...child, active: !stopped } }));
      } else if (request.method === 'POST' && request.url === '/v2/sessions/native-fork-child/archive' && stopped) {
        archived = true;
        response.end(JSON.stringify({ success: true, archivedAt: 1 }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Session not found' }));
      }
    });
    await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Expected Home HTTP listener');
    try {
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
        const response = await operations.observeExecution({ actionId: 'session.fork', input: { requestId: 'native-fork-original' },
          execute: async operation => {
            const result = await runRequesterSessionLifecycle({ sessionId: 'parent',
              context: { signal: operation.signal, localActionContext: operation },
              spawnSession: async options => {
                expect(options.nativeForkSource).toMatchObject({ sessionId: 'parent', providerSessionId: 'provider-parent' });
                if (outcome === 'refused') tracked.agentRuntimeDaemonServiceSessionOpenAttestation =
                  AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema.parse({ request: { kind: 'fork',
                    sessionId: 'native-fork-child', cwd: '/project', source: options.nativeForkSource },
                    providerSessionId: null, refusal: { code: 'native_agent_session_mode_unavailable' } });
                else tracked.childProcess = Object.assign(new (await import('node:child_process')).ChildProcess(), { exitCode: 1 });
                return { type: 'success', sessionId: 'native-fork-child' };
              },
              awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], ...input }),
              stopSession: async () => { throw new Error('Native fork owns its own retirement'); },
              refused: () => ({ ok: false as const, errorCode: 'requester_unavailable', errorMessage: 'unavailable' }),
              run: ({ spawnSession }) => attemptNativeForkOpen({ credentials: { token: 'test-token', encryption: null },
                parentSessionId: 'parent', parentMetadata, directory: '/project', forkPoint: { type: 'latest' },
                targetSeqInclusive: 0, effectiveCutoffSeqInclusive: 0, spawnNonce: 'native-fork-nonce',
                forkBackendResolution: { ok: true, catalogAgentId: null, agentHintAgentId: 'acme-agent',
                  backendTargetV2: { kind: 'backend', backendId: 'acme-agent' },
                  backendTarget: { kind: 'configuredAcpBackend', backendId: 'acme-agent' }, replayFlavor: 'acme-agent', metadataOverlay: {} },
                inheritedForkOverrides: { spawn: {}, metadata: {} }, spawnSession,
                stopSession: async sessionId => { expect(sessionId).toBe('native-fork-child'); stopped = true; return true; },
                awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], ...input }),
              }),
            });
            if (!result) throw new Error('Native fork did not select an open strategy');
            return result.ok ? { ok: true, result } : { ok: false, errorCode: result.errorCode, error: result.errorMessage };
          } });
        expect(response.ok).toBe(false);
        expect(stopped).toBe(true);
        expect(archived).toBe(true);
        expect(operations.store.get({ accountId: 'account', machineId: 'machine' }, 'native-fork-startup'))
          .toMatchObject({ state: 'failed' });
      });
    } finally {
      operations.runner.cancel({ accountId: 'account', machineId: 'machine' }, 'native-fork-startup');
      home.closeAllConnections();
      await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    }
  });

  it('keeps the same original operation for a cold fork child spawned by the requester lifecycle', async () => {
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
      generateOperationId: () => 'fork-startup', supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { pid: 101, startedBy: 'daemon', happySessionId: 'fork-child',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/fork-authority.json' };
    let captured: SpawnSessionOptions | undefined;
    const response = operations.observeExecution({ actionId: 'session.fork', input: { requestId: 'fork-original' },
      execute: async operation => ({ ok: true, result: await runRequesterSessionLifecycle({ sessionId: 'parent',
        context: { signal: operation.signal, localActionContext: operation },
        spawnSession: async options => { captured = options; return { type: 'success', sessionId: 'fork-child' }; },
        awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ getTrackedSessions: () => [tracked], ...input }),
        stopSession: async () => { throw new Error('Successful startup must not retire its runner'); },
        refused: () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE, errorMessage: 'unavailable' } as const),
        run: ({ spawnSession }) => spawnSession({ directory: '/project' }),
      }) }) });
    try {
      await vi.waitFor(() => expect(captured).toBeDefined());
      expect(captured?.projectSetupOperation?.operationAcceptance?.operationId).toBe('fork-startup');
      expect(operations.store.get({ accountId: 'account', machineId: 'machine' }, 'fork-startup')).toMatchObject({ state: 'running' });
      tracked.agentRuntimeDaemonServiceSessionOpenAttestation = { request: { kind: 'create', sessionId: 'fork-child', cwd: '/project' },
        providerSessionId: 'native-fork' };
      expect(await response).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'fork-child' } });
    } finally { operations.runner.cancel({ accountId: 'account', machineId: 'machine' }, 'fork-startup'); await response.catch(() => undefined); }
  });
  it.each(['open', 'cancel', 'exit'] as const)('retains the original operation after webhook acknowledgement until native startup can %s', async outcome => {
    vi.useFakeTimers();
    const scope = { accountId: 'account', machineId: 'machine' };
    const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId, generateOperationId: () => 'original-startup',
      supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { pid: 100, startedBy: 'daemon', happySessionId: 'session-child',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/authority.json' };
    const trackedSessions = [tracked];
    let captured: SpawnSessionOptions | undefined;
    // Physical runner launch/webhook is the OS boundary. Its later open is
    // observed by the actual tracked-runner startup owner, not a test promise.
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession: async options => {
      captured = options;
      return { type: 'success', sessionId: 'session-child' };
    }, stopSession: async () => { throw new Error('Open, cancellation and observed exit do not retire a refused runner'); },
    awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({
      getTrackedSessions: () => trackedSessions, ...input,
    }) });
    try {
      const response = await operations.observeExecution({ actionId: 'session.spawn_new',
        input: { creationKey: 'same-creation' }, execute: async operation => {
          try {
            return { ok: true, result: await handler({ directory: '/project',
              agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            }, { signal: operation.signal, localActionContext: operation }) };
          } catch (error) {
            if (operation.signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
            throw error;
          }
        } });
      expect(response).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
        operation: { serverId: 'home', machineId: scope.machineId, operationId: 'original-startup' } } });
      if (!response.ok) throw new Error('Expected accepted startup');
      expect(SessionSpawnNewResultV1Schema.parse(response.result)).toEqual(response.result);
      expect(await operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'same-creation' },
        execute: async () => { throw new Error('An existing startup must not spawn again'); } })).toEqual(response);
      expect(captured?.projectSetupOperation?.operationAcceptance?.operationId).toBe('original-startup');
      expect(operations.store.get(scope, 'original-startup')).toMatchObject({ state: 'running' });
      await vi.advanceTimersByTimeAsync(15_100);
      expect(operations.store.get(scope, 'original-startup')).not.toHaveProperty('settledAt');
      if (outcome === 'cancel') {
        expect(operations.runner.cancel(scope, 'original-startup')).toEqual({ kind: 'requested' });
        expect(captured?.projectSetupOperation?.signal.aborted).toBe(true);
      } else if (outcome === 'exit') {
        trackedSessions.length = 0;
        await vi.advanceTimersByTimeAsync(25);
      } else {
        tracked.agentRuntimeDaemonServiceSessionOpenAttestation = {
          request: { kind: 'create', sessionId: 'session-child', cwd: '/project' }, providerSessionId: 'native-child',
        };
        await vi.advanceTimersByTimeAsync(25);
      }
      await vi.waitFor(() => expect(operations.store.get(scope, 'original-startup')).toMatchObject({
        state: outcome === 'cancel' ? 'cancelled' : outcome === 'exit' ? 'failed' : 'succeeded',
      }));
    } finally { vi.useRealTimers(); }
  });
});
