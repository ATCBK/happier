import { describe, expect, it, vi } from 'vitest';

import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { awaitTrackedRunnerAgentSessionOpen } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import type { TrackedSession } from '@/daemon/types';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

import { createSpawnNewSessionLifecycleActionHandler } from './createSpawnNewSessionLifecycleActionHandler';
import { runRequesterSessionLifecycle } from './requesterSessionLifecycle';

describe('Session startup operation custody', () => {
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
  it.each(['open', 'cancel'] as const)('retains the original operation after webhook acknowledgement until native startup can %s', async outcome => {
    vi.useFakeTimers();
    const scope = { accountId: 'account', machineId: 'machine' };
    const operations = createHostActionOperationRuntime({ machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId, generateOperationId: () => 'original-startup',
      supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { pid: 100, startedBy: 'daemon', happySessionId: 'session-child',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/authority.json' };
    let captured: SpawnSessionOptions | undefined;
    // Physical runner launch/webhook is the OS boundary. Its later open is
    // observed by the actual tracked-runner startup owner, not a test promise.
    const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession: async options => {
      captured = options;
      return { type: 'success', sessionId: 'session-child' };
    }, awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({
      getTrackedSessions: () => [tracked], ...input,
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
      expect(response).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true } });
      expect(captured?.projectSetupOperation?.operationAcceptance?.operationId).toBe('original-startup');
      expect(operations.store.get(scope, 'original-startup')).toMatchObject({ state: 'running' });
      await vi.advanceTimersByTimeAsync(15_100);
      expect(operations.store.get(scope, 'original-startup')).not.toHaveProperty('settledAt');
      if (outcome === 'cancel') {
        expect(operations.runner.cancel(scope, 'original-startup')).toEqual({ kind: 'requested' });
        expect(captured?.projectSetupOperation?.signal.aborted).toBe(true);
      } else {
        tracked.agentRuntimeDaemonServiceSessionOpenAttestation = {
          request: { kind: 'create', sessionId: 'session-child', cwd: '/project' }, providerSessionId: 'native-child',
        };
        await vi.advanceTimersByTimeAsync(25);
      }
      await vi.waitFor(() => expect(operations.store.get(scope, 'original-startup')).toMatchObject({
        state: outcome === 'cancel' ? 'cancelled' : 'succeeded',
      }));
    } finally { vi.useRealTimers(); }
  });
});
