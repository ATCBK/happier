import { describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceSwitchDeferralConflictError,
  createConnectedServiceSwitchDeferralQueue,
} from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import type { TrackedSession } from '../types';
import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';
import type { RestartSessionRunnerCompletion } from './restartSessionRunnerOnCurrentRuntime';
import { createVersionRuntimeRefreshAttemptHandoff } from './versionRuntimeRefreshAttemptHandoff';
import { waitForTrackedRunnerProcessesExit } from '../sessions/waitForTrackedRunnerProcessesExit';
import type { PlannedRunnerRestartSignalRequest } from './types';
import { requestConnectedServiceSessionRestartSignal } from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';

function makeTracked(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    pid: 4242,
    happySessionId: 'sess-1',
    startedBy: 'daemon',
    processCommandHash: 'hash-1',
    processStartTimeMs: 12_345,
    spawnOptions: { directory: '/repo', resume: 'vendor-1' },
    ...overrides,
  } as TrackedSession;
}

describe('requestPlannedRunnerRestart', () => {
  it('reserves the tracked pid before signaling and leaves respawn reservation for requested signal', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const isProcessSafeToSignal = vi.fn(async () => true);
    const requestSignal = vi.fn(async (input) => {
      expect(restartRequestedPids.has(tracked.pid)).toBe(true);
      await expect(input.shouldSignal()).resolves.toBe(true);
      return { status: 'requested' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({ signaled: true });

    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: tracked.pid,
      expectedProcessCommandHash: 'hash-1',
      expectedProcessStartTimeMs: 12_345,
    });
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('refuses an overlapping restart already reserved for the same tracked pid', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>([tracked.pid]);
    const requestSignal = vi.fn();

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'restart_already_running' });

    expect(requestSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids).toEqual(new Set([tracked.pid]));
  });

  it('clears reservation and reports no signal when ownership changes before signal', async () => {
    const tracked = makeTracked();
    const replacement = makeTracked({ pid: tracked.pid, happySessionId: 'sess-1' });
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const clearRestartIntentForPid = vi.fn();
    const requestSignal = vi.fn(async (input) => {
      pidToTrackedSession.set(tracked.pid, replacement);
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      clearRestartIntentForPid,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'stale_owner' });

    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
    expect(clearRestartIntentForPid).toHaveBeenCalledWith(tracked.pid, expect.stringContaining('stale'));
  });

  it('passes exact command and process birth identity to the final PID safety check', async () => {
    const tracked = makeTracked({
      processCommandHash: 'hash-1',
      processStartTimeMs: 12_345,
    });
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const clearRestartIntentForPid = vi.fn();
    const isProcessSafeToSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async (input) => {
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      clearRestartIntentForPid,
      isProcessSafeToSignal,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'unsafe_process' });

    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: tracked.pid,
      expectedProcessCommandHash: 'hash-1',
      expectedProcessStartTimeMs: 12_345,
    });
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
    expect(clearRestartIntentForPid).toHaveBeenCalledWith(tracked.pid, expect.stringContaining('stale'));
  });

  it.each([
    ['missing process birth', { processCommandHash: 'hash-1', processStartTimeMs: undefined }],
    ['non-finite process birth', { processCommandHash: 'hash-1', processStartTimeMs: Number.NaN }],
  ] satisfies ReadonlyArray<readonly [string, Partial<TrackedSession>]>) (
    'does not reserve or enter the signal primitive with %s',
    async (_label, overrides) => {
      const tracked = makeTracked(overrides);
      const restartRequestedPids = new Set<number>();
      const requestSignal = vi.fn(async () => ({
        status: 'requested' as const,
      }));
      const isProcessSafeToSignal = vi.fn(async () => true);

      await expect(requestPlannedRunnerRestart({
        sessionId: 'sess-1',
        tracked,
        deferral: { kind: 'none' },
        restartRequestedPids,
        pidToTrackedSession: new Map([[tracked.pid, tracked]]),
        requestSignal,
        isProcessSafeToSignal,
      })).resolves.toEqual({
        signaled: false,
        notSignaledReason: 'unsafe_process',
      });

      expect(requestSignal).not.toHaveBeenCalled();
      expect(isProcessSafeToSignal).not.toHaveBeenCalled();
      expect(restartRequestedPids).toEqual(new Set());
    },
  );

  it('admits a captured process birth without a command hash when the live identity verifies it', async () => {
    const tracked = makeTracked({ processCommandHash: undefined, processStartTimeMs: 12_345 });
    const isProcessSafeToSignal = vi.fn(async () => true);
    const requestSignal = vi.fn(async ({ shouldSignal }: { shouldSignal: () => boolean | Promise<boolean> }) => ({
      status: await shouldSignal() ? 'requested' as const : 'skipped_stale_owner' as const,
    }));
    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids: new Set<number>(),
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({ signaled: true });
    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: tracked.pid,
      expectedProcessCommandHash: '',
      expectedProcessStartTimeMs: 12_345,
    });
  });

  it('rechecks the request-start command and process birth witness before PID safety', async () => {
    const tracked = makeTracked({
      processCommandHash: 'hash-1',
      processStartTimeMs: 12_345,
    });
    const restartRequestedPids = new Set<number>();
    const isProcessSafeToSignal = vi.fn(async () => true);
    const requestSignal = vi.fn(async (input) => {
      tracked.processCommandHash = 'hash-replacement';
      tracked.processStartTimeMs = 12_346;
      const shouldSignal = await input.shouldSignal();
      return shouldSignal
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({
      signaled: false,
      notSignaledReason: 'unsafe_process',
    });

    expect(requestSignal).toHaveBeenCalledOnce();
    expect(isProcessSafeToSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids).toEqual(new Set());
  });

  it('rechecks the tracked witness after a successful asynchronous signal gate', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const isProcessSafeToSignal = vi.fn(async () => true);
    const canSignal = vi.fn(async () => {
      tracked.processCommandHash = 'hash-replacement';
      tracked.processStartTimeMs = 12_346;
      return true;
    });
    const requestSignal = vi.fn(async (input) => {
      const shouldSignal = await input.shouldSignal();
      return shouldSignal
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
      canSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({
      signaled: false,
      notSignaledReason: 'unsafe_process',
    });

    expect(canSignal).toHaveBeenCalledOnce();
    expect(isProcessSafeToSignal).toHaveBeenCalledOnce();
    expect(restartRequestedPids).toEqual(new Set());
  });

  it('repeats the live OS witness as the last check after a successful asynchronous signal gate', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const events: string[] = [];
    const isProcessSafeToSignal = vi.fn()
      .mockImplementationOnce(async () => {
        events.push('initial_os_witness');
        return true;
      })
      .mockImplementationOnce(async () => {
        events.push('final_os_witness');
        return false;
      });
    const canSignal = vi.fn(async () => {
      events.push('signal_gate');
      return true;
    });
    const requestSignal = vi.fn(async (input) => {
      const shouldSignal = await input.shouldSignal();
      events.push(shouldSignal ? 'signal' : 'blocked');
      return shouldSignal
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession: new Map([[tracked.pid, tracked]]),
      requestSignal,
      canSignal,
      isProcessSafeToSignal,
    })).resolves.toEqual({
      signaled: false,
      notSignaledReason: 'unsafe_process',
    });

    expect(events).toEqual([
      'initial_os_witness',
      'signal_gate',
      'final_os_witness',
      'blocked',
    ]);
    expect(restartRequestedPids).toEqual(new Set());
  });

  it('clears reservation and reports no signal when activity starts before signal', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const canSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async (input) => {
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      canSignal,
      isProcessSafeToSignal: async () => true,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'activity_in_progress' });

    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('preserves exact disabled reason when activity gate blocks before signal', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const canSignal = vi.fn(async () => 'approval_pending' as const);
    const requestSignal = vi.fn(async (input) => {
      await expect(input.shouldSignal()).resolves.toBe(false);
      return { status: 'skipped_stale_owner' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      canSignal,
      isProcessSafeToSignal: async () => true,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'approval_pending' });

    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('observes an already-missing process once and keeps the forced-respawn reservation', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const observeProcessMissing = vi.fn();
    const requestSignal = vi.fn(async (input) => {
      input.onProcessAlreadyMissing();
      return { status: 'process_already_missing' as const };
    });

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      observeProcessMissing,
    })).resolves.toEqual({ signaled: true });

    expect(observeProcessMissing).toHaveBeenCalledTimes(1);
    expect(observeProcessMissing).toHaveBeenCalledWith(tracked);
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('returns no signal for superseded deferred switches', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const requestSignal = vi.fn();

    await expect(requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: {
        kind: 'connected_service_switch',
        source: 'manual',
        policy: 'defer_until_turn_boundary',
        target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 },
        turnDeferralQueue: {
          requestSwitch: async () => {
            throw new ConnectedServiceSwitchDeferralConflictError({
              code: 'switch_cancelled',
              message: 'superseded',
            });
          },
        },
      },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
    })).resolves.toEqual({ signaled: false, notSignaledReason: 'superseded' });

    expect(requestSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
  });
  it('reports an emitted restart signal as signaled even when the deferred completion event cannot be admitted', async () => {
    // POST-EFFECT SETTLEMENT (composition of the real deferral queue with the restart primitive):
    // the SIGTERM has already left the daemon. If the completion transcript event then fails to be
    // admitted, throwing here would tell the caller the restart never happened — and every caller
    // answers that by restoring pre-effect bindings and spawn options over a runner that is already
    // dying. The signal is irreversible, so the result must stay `signaled: true`.
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const requestSignal = vi.fn(async () => ({ status: 'requested' as const }));
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({
      timeoutMs: 60_000,
      disableDeferral: false,
      emitSessionEvent: async (_sessionId, event) => {
        if ((event as { type?: string }).type === 'connected_service_account_switch_deferral_completed') {
          throw new Error('transcript_admission_failed');
        }
      },
    });

    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
    const restart = requestPlannedRunnerRestart({
      sessionId: 'sess-1',
      tracked,
      deferral: {
        kind: 'connected_service_switch',
        source: 'manual',
        policy: 'defer_until_turn_boundary',
        target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 },
        turnDeferralQueue,
      },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      isProcessSafeToSignal: async () => true,
    });

    await Promise.resolve();
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });

    await expect(restart).resolves.toEqual({ signaled: true });
    expect(requestSignal).toHaveBeenCalledTimes(1);
  });
});


describe('requestPlannedRunnerRestart shared refresh completion', () => {
  function makeHandoff() {
    return createVersionRuntimeRefreshAttemptHandoff<RestartSessionRunnerCompletion>({
      timeoutMs: 60_000,
      timeoutCompletion: { ok: false, status: 'partial_failure' },
      supersededCompletion: { ok: false, status: 'partial_failure', diagnostics: { reason: 'superseded' } },
      cancelledCompletion: { ok: false, status: 'partial_failure', diagnostics: { reason: 'cancelled' } },
    });
  }

  it('joins equivalent requests without replacing the original completion or signaling again', async () => {
    const tracked = makeTracked();
    const handoff = makeHandoff();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const requestSignal = vi.fn(async (input: PlannedRunnerRestartSignalRequest) => ({
      status: await input.shouldSignal() ? 'requested' as const : 'skipped_stale_owner' as const,
    }));
    const target = { sessionId: 'sess-1', previousPid: tracked.pid, tracked, transientSpawnOptions: tracked.spawnOptions };
    const completion = {
      hasPending: () => handoff.has('sess-1', tracked.pid),
      join: () => handoff.join({ ...target, transientSpawnOptions: { ...tracked.spawnOptions! } }),
      create: () => handoff.create(target),
    };
    const request = {
      sessionId: 'sess-1', tracked, deferral: { kind: 'none' as const },
      restartRequestedPids, pidToTrackedSession, requestSignal,
      isProcessSafeToSignal: async () => true, completion,
    };
    const first = requestPlannedRunnerRestart(request);
    const replay = requestPlannedRunnerRestart(request);
    await vi.waitFor(() => expect(requestSignal).toHaveBeenCalledOnce());
    const outcome = { ok: true, next: { pid: 4343 } } as const;
    handoff.settle('sess-1', tracked.pid, outcome);

    await expect(first).resolves.toEqual({ signaled: true, completion: outcome });
    await expect(replay).resolves.toEqual({ signaled: true, completion: outcome });
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('keeps differing transient spawn targets busy without cancelling the accepted request', async () => {
    const tracked = makeTracked();
    const handoff = makeHandoff();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const requestSignal = vi.fn(async (input: PlannedRunnerRestartSignalRequest) => ({
      status: await input.shouldSignal() ? 'requested' as const : 'skipped_stale_owner' as const,
    }));
    const originalTarget = { sessionId: 'sess-1', previousPid: tracked.pid, tracked, transientSpawnOptions: tracked.spawnOptions };
    const request = {
      sessionId: 'sess-1', tracked, deferral: { kind: 'none' as const },
      restartRequestedPids, pidToTrackedSession, requestSignal,
      isProcessSafeToSignal: async () => true,
    };
    const first = requestPlannedRunnerRestart({ ...request, completion: {
      hasPending: () => handoff.has('sess-1', tracked.pid),
      join: () => handoff.join(originalTarget),
      create: () => handoff.create(originalTarget),
    } });
    const differentTarget = { ...originalTarget, transientSpawnOptions: { ...tracked.spawnOptions!, resume: 'vendor-other' } };
    await expect(requestPlannedRunnerRestart({ ...request, completion: {
      hasPending: () => handoff.has('sess-1', tracked.pid),
      join: () => handoff.join(differentTarget),
      create: () => handoff.create(differentTarget),
    } })).resolves.toEqual({ signaled: false, notSignaledReason: 'restart_already_running' });
    expect(handoff.takeTransientSpawnOptions('sess-1', tracked.pid)).toEqual(tracked.spawnOptions);
    const outcome = { ok: true } as const;
    handoff.settle('sess-1', tracked.pid, outcome);
    await expect(first).resolves.toEqual({ signaled: true, completion: outcome });
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('retains the original completion and reservation when a deferred auth switch overlaps it', async () => {
    const tracked = makeTracked();
    const handoff = makeHandoff();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const requestSignal = vi.fn(async (input: PlannedRunnerRestartSignalRequest) => ({
      status: await input.shouldSignal() ? 'requested' as const : 'skipped_stale_owner' as const,
    }));
    const target = { sessionId: 'sess-1', previousPid: tracked.pid, tracked };
    const request = {
      sessionId: 'sess-1', tracked, restartRequestedPids, pidToTrackedSession, requestSignal,
      isProcessSafeToSignal: async () => true,
    };
    const first = requestPlannedRunnerRestart({ ...request, deferral: { kind: 'none' }, completion: {
      hasPending: () => handoff.has('sess-1', tracked.pid),
      join: () => handoff.join(target), create: () => handoff.create(target),
    } });
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
    const overlap = requestPlannedRunnerRestart({ ...request, deferral: {
      kind: 'connected_service_switch', source: 'manual', policy: 'defer_until_turn_boundary',
      target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 }, turnDeferralQueue,
    } });
    await Promise.resolve();
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    await expect(overlap).resolves.toEqual({ signaled: false, notSignaledReason: 'restart_already_running' });
    const outcome = { ok: true } as const;
    handoff.settle('sess-1', tracked.pid, outcome);
    await expect(first).resolves.toEqual({ signaled: true, completion: outcome });
    expect(requestSignal).toHaveBeenCalledOnce();
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('observes a slow adopted runner through physical exit for the refresh completion lifetime', async () => {
    vi.useFakeTimers();
    try {
      const tracked = makeTracked();
      const handoff = makeHandoff();
      const startedAtMs = Date.now();
      const target = { sessionId: 'sess-1', previousPid: tracked.pid, tracked };
      const result = requestPlannedRunnerRestart({
        sessionId: 'sess-1', tracked, deferral: { kind: 'none' },
        restartRequestedPids: new Set<number>(), pidToTrackedSession: new Map([[tracked.pid, tracked]]),
        isProcessSafeToSignal: async () => true,
        requestSignal: async (input) => ({
          status: await input.shouldSignal() ? 'requested' : 'skipped_stale_owner',
        }),
        completion: {
          hasPending: () => handoff.has('sess-1', tracked.pid),
          join: () => handoff.join(target),
          create: () => handoff.create(target),
        },
        observeRunnerRetirement: () => {
          // Process-state reading is the OS boundary; the physical-exit wait and handoff stay real.
          void waitForTrackedRunnerProcessesExit({
            runners: [{ pid: tracked.pid }], timeoutMs: 60_000, pollIntervalMs: 500,
            readRunState: async () => Date.now() - startedAtMs >= 45_000 ? 'dead' : 'servable',
            onExitObserved: () => handoff.settle('sess-1', tracked.pid, { ok: true, next: { pid: 4343 } }),
          });
        },
      });
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(result).resolves.toEqual({ signaled: true, completion: { ok: true, next: { pid: 4343 } } });
    } finally {
      vi.useRealTimers();
    }
  });

});


describe('requestPlannedRunnerRestart selected deferral outcome', () => {
  it('reports the selected signal to same-target callers even when retirement precedes their continuation', async () => {
    const tracked = makeTracked();
    const restartRequestedPids = new Set<number>();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    const requestSignal = vi.fn(async () => {
      // The real exit/respawn owner can retire the reservation before deferred callers resume.
      restartRequestedPids.delete(tracked.pid);
      return { status: 'requested' as const };
    });
    const request = {
      sessionId: 'sess-1', tracked, restartRequestedPids, pidToTrackedSession,
      isProcessSafeToSignal: async () => true, requestSignal,
      deferral: {
        kind: 'connected_service_switch' as const, source: 'manual' as const,
        policy: 'defer_until_turn_boundary' as const,
        target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 }, turnDeferralQueue,
      },
    };
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
    const first = requestPlannedRunnerRestart(request);
    const replay = requestPlannedRunnerRestart(request);
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });

    await expect(first).resolves.toEqual({ signaled: true });
    await expect(replay).resolves.toEqual({ signaled: true });
    expect(requestSignal).toHaveBeenCalledOnce();
  });

  it('retains the selected signal when session_restarting arrives while its callback finishes', async () => {
    const tracked = makeTracked();
    const turnDeferralQueue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    const requestSignal = vi.fn(async () => {
      await turnDeferralQueue.cancelSession('sess-1', 'session_restarting');
      return { status: 'requested' as const };
    });
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
    const result = requestPlannedRunnerRestart({
      sessionId: 'sess-1', tracked, restartRequestedPids: new Set<number>(),
      pidToTrackedSession: new Map([[tracked.pid, tracked]]), requestSignal,
      isProcessSafeToSignal: async () => true,
      deferral: {
        kind: 'connected_service_switch', source: 'manual', policy: 'defer_until_turn_boundary',
        target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 }, turnDeferralQueue,
      },
    });
    turnDeferralQueue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    await expect(result).resolves.toEqual({ signaled: true });
  });
});


describe('requestPlannedRunnerRestart cancelled signal admission', () => {
  it.each(['delay', 'process_identity', 'activity'] as const)('does not signal after the owning queue times out during %s', async (boundary) => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const tracked = makeTracked();
      const restartRequestedPids = new Set<number>();
      const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 1_000, disableDeferral: false });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'prompt_or_steer' });
      const result = requestPlannedRunnerRestart({
        sessionId: 'sess-1', tracked, restartRequestedPids,
        pidToTrackedSession: new Map([[tracked.pid, tracked]]),
        deferral: { kind: 'connected_service_switch', source: 'manual', policy: 'defer_until_turn_boundary',
          target: { serviceId: 'svc', profileId: 'profile', groupId: 'group', generation: 2 }, turnDeferralQueue: queue },
        isProcessSafeToSignal: async () => {
          if (boundary === 'process_identity') await held;
          return true;
        },
        canSignal: async () => {
          if (boundary === 'activity') await held;
          return true;
        },
        requestSignal: (input) => requestConnectedServiceSessionRestartSignal({
          pid: tracked.pid, delayMs: boundary === 'delay' ? 1_500 : 0,
          shouldSignal: input.shouldSignal, onSignalFailure: input.onSignalFailure,
          onProcessAlreadyMissing: input.onProcessAlreadyMissing,
        }),
      });
      const rejected = expect(result).rejects.toMatchObject({ code: 'switch_execution_timeout' });
      queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(restartRequestedPids.has(tracked.pid)).toBe(false);
      release();
      await vi.advanceTimersByTimeAsync(500);
      expect(kill).not.toHaveBeenCalled();
      await queue.cancelAll('daemon_shutdown');
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });
});
