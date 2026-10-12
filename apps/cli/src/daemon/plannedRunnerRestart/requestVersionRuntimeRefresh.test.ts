import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import { createRestartCompletionWaiters } from './completionWaiters';
import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';
import { requestVersionRuntimeRefresh } from './requestVersionRuntimeRefresh';

function trackedSession(): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'claude-thread-1',
    } satisfies SpawnSessionOptions,
  };
}

function createHarness() {
  const tracked = trackedSession();
  const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
  const restartRequestedPids = new Set<number>();
  const completionWaiters = createRestartCompletionWaiters({ timeoutMs: 60_000 });
  // The runner keeps exiting after the first SIGTERM, so its pid identity no longer verifies.
  let runnerExiting = false;
  const sendSignal = vi.fn(() => {
    runnerExiting = true;
  });
  const observeRunnerRetirement = vi.fn();

  const request = () => requestVersionRuntimeRefresh({
    sessionId: 'sess-1',
    tracked,
    completionWaiters,
    restartRequestedPids,
    observeRunnerRetirement,
    requestRestart: async () => await requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      isProcessSafeToSignal: async () => !runnerExiting,
      requestSignal: async ({ shouldSignal }) => {
        if (!await shouldSignal()) return { status: 'skipped_stale_owner' as const };
        sendSignal();
        return { status: 'requested' as const };
      },
      logDebug: () => {},
    }),
  });

  return { tracked, restartRequestedPids, completionWaiters, sendSignal, observeRunnerRetirement, request };
}

describe('requestVersionRuntimeRefresh', () => {
  it('joins an in-flight restart instead of re-signalling or cancelling its respawn intent', async () => {
    const harness = createHarness();

    const first = harness.request();
    await vi.waitFor(() => expect(harness.sendSignal).toHaveBeenCalledTimes(1));
    const duplicate = harness.request();

    expect(harness.restartRequestedPids.has(harness.tracked.pid)).toBe(true);
    harness.completionWaiters.settle('sess-1', harness.tracked.pid, { ok: true });

    await expect(first).resolves.toEqual({ signaled: true, completion: { ok: true } });
    await expect(duplicate).resolves.toEqual({ signaled: true, completion: { ok: true } });
    expect(harness.sendSignal).toHaveBeenCalledTimes(1);
    expect(harness.observeRunnerRetirement).toHaveBeenCalledTimes(1);
  });

  it('reports a duplicate rather than a signalled restart when the joined restart never signals', async () => {
    const harness = createHarness();
    const pendingCreator = harness.completionWaiters.create('sess-1', harness.tracked.pid);

    const joiner = harness.request();
    pendingCreator.cancel();

    await expect(joiner).resolves.toEqual({ signaled: false, notSignaledReason: 'duplicate_restart' });
    expect(harness.sendSignal).not.toHaveBeenCalled();
  });

  it('reports a duplicate without signalling when another pending restart already reserved the runner', async () => {
    const harness = createHarness();
    harness.restartRequestedPids.add(harness.tracked.pid);

    await expect(harness.request()).resolves.toEqual({
      signaled: false,
      notSignaledReason: 'duplicate_restart',
    });
    expect(harness.sendSignal).not.toHaveBeenCalled();
    expect(harness.restartRequestedPids.has(harness.tracked.pid)).toBe(true);
  });

  it('releases its waiter when the restart is not signalled', async () => {
    const harness = createHarness();
    const refused = requestVersionRuntimeRefresh({
      sessionId: 'sess-1',
      tracked: harness.tracked,
      completionWaiters: harness.completionWaiters,
      restartRequestedPids: harness.restartRequestedPids,
      observeRunnerRetirement: harness.observeRunnerRetirement,
      requestRestart: async () => ({ signaled: false, notSignaledReason: 'activity_in_progress' as const }),
    });

    await expect(refused).resolves.toEqual({ signaled: false, notSignaledReason: 'activity_in_progress' });
    expect(harness.completionWaiters.join('sess-1', harness.tracked.pid)).toBeNull();
    expect(harness.observeRunnerRetirement).not.toHaveBeenCalled();
  });
});
