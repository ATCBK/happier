import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { enqueueRuntimeAuthFailureReportOutboxItem, readRuntimeAuthFailureReportOutboxItems } from './runtimeAuthFailureReportOutbox';
import { drainRuntimeAuthFailureReportOutboxToDaemon } from './runtimeAuthFailureReportOutboxDrain';

import {
  resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests,
  scheduleRuntimeAuthFailureReportOutboxDrainToDaemon,
} from './runtimeAuthFailureReportOutboxDrainScheduler';

describe('runtimeAuthFailureReportOutboxDrainScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests();
  });

  afterEach(() => {
    resetRuntimeAuthFailureReportOutboxDrainSchedulerForTests();
    vi.useRealTimers();
  });

  it('delivers every retained report after daemon replacement even beyond eight items and eight failed attempts', async () => {
    const outboxDir = await createTempDir('happier-outbox-scheduler-retained-');
    try {
      for (let index = 0; index < 10; index += 1) {
        await enqueueRuntimeAuthFailureReportOutboxItem({
          outboxDir,
          report: {
            sessionId: `session-${index}`,
            classification: {
              kind: 'auth_expired',
              serviceId: 'claude-subscription',
              profileId: 'primary',
              groupId: null,
              resetsAtMs: null,
              planType: null,
              rateLimits: null,
              source: 'structured_provider_error',
            },
          },
        });
      }
      let available = false;
      let pendingDrain: Promise<unknown> | undefined;
      scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
        outboxDir,
        delayMs: 0,
        retryDelayMs: 1,
        drain: (input) => {
          const operation = drainRuntimeAuthFailureReportOutboxToDaemon({
            ...input,
            notify: async ({ reportId }) => available
              ? { ok: true, result: { status: 'credential_refreshed' }, recoveryReceipt: { reportId, attemptId: `attempt-${reportId}` } }
              : { ok: false, errorCode: 'daemon_unavailable' },
          });
          pendingDrain = operation;
          return operation;
        },
      });
      for (let attempt = 0; attempt < 9; attempt += 1) {
        await vi.advanceTimersToNextTimerAsync();
        await pendingDrain;
      }
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toHaveLength(10);
      available = true;
      await vi.advanceTimersToNextTimerAsync();
      await pendingDrain;
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([]);
    } finally {
      await removeTempDir(outboxDir);
    }
  });

  it('drains a report enqueued after the active drain has read its persisted snapshot', async () => {
    const outboxDir = await createTempDir('happier-outbox-scheduler-wake-');
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const notified = new Set<string>();
    const drains: Promise<unknown>[] = [];
    const report = (sessionId: string) => ({
      sessionId,
      classification: {
        kind: 'auth_expired',
        serviceId: 'claude-subscription',
        profileId: 'primary',
        groupId: null,
        resetsAtMs: null,
        planType: null,
        rateLimits: null,
        source: 'structured_provider_error',
      },
    });
    const input = {
      outboxDir,
      delayMs: 0,
      drain: (drainInput: Parameters<typeof drainRuntimeAuthFailureReportOutboxToDaemon>[0]) => {
        const operation = drainRuntimeAuthFailureReportOutboxToDaemon({
          ...drainInput,
          notify: async ({ sessionId, reportId }) => {
            if (sessionId === 'first') {
              firstStarted?.();
              await blocked;
            }
            notified.add(sessionId);
            return { recoveryReceipt: { reportId } };
          },
        });
        drains.push(operation);
        return operation;
      },
    };
    try {
      await enqueueRuntimeAuthFailureReportOutboxItem({ outboxDir, report: report('first') });
      scheduleRuntimeAuthFailureReportOutboxDrainToDaemon(input);
      await vi.advanceTimersToNextTimerAsync();
      await started;
      await enqueueRuntimeAuthFailureReportOutboxItem({ outboxDir, report: report('second') });
      scheduleRuntimeAuthFailureReportOutboxDrainToDaemon(input);
      releaseFirst?.();
      await drains[0];
      await vi.advanceTimersToNextTimerAsync();
      await drains.at(-1);
      expect(notified).toEqual(new Set(['first', 'second']));
      expect(await readRuntimeAuthFailureReportOutboxItems({ outboxDir })).toEqual([]);
    } finally {
      releaseFirst?.();
      await Promise.allSettled(drains);
      await removeTempDir(outboxDir);
    }
  });

  it('coalesces duplicate schedules into one pending outbox wake while active', async () => {
    let resolveDrain: (() => void) | undefined;
    const drain = vi.fn(() => new Promise<{ delivered: number; dropped: number; retried: number }>((resolve) => {
      resolveDrain = () => resolve({ delivered: 1, dropped: 0, retried: 0 });
    }));

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      outboxDir: '/tmp/outbox',
      delayMs: 10,
      drain,
    });
    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      outboxDir: '/tmp/outbox',
      delayMs: 10,
      drain,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledOnce();

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      outboxDir: '/tmp/outbox',
      delayMs: 10,
      drain,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(drain).toHaveBeenCalledOnce();

    expect(resolveDrain).toBeTypeOf('function');
    resolveDrain?.();
    await vi.runAllTimersAsync();

    expect(drain).toHaveBeenCalledTimes(2);
    resolveDrain?.();
    await vi.runAllTimersAsync();
    expect(drain).toHaveBeenCalledWith({
      outboxDir: '/tmp/outbox',
    });
  });

  it('backs off and retries when the drain leaves retryable items queued', async () => {
    const drain = vi
      .fn()
      .mockResolvedValueOnce({ delivered: 0, dropped: 0, retried: 1 })
      .mockResolvedValueOnce({ delivered: 1, dropped: 0, retried: 0 });

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      drain,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(19);
    expect(drain).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('reschedules after a failed drain attempt', async () => {
    const drain = vi
      .fn()
      .mockRejectedValueOnce(new Error('daemon unavailable'))
      .mockResolvedValueOnce({ delivered: 1, dropped: 0, retried: 0 });

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      retryDelayMs: 20,
      drain,
      logger: { debug: vi.fn() },
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(drain).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('unrefs scheduled timers when the timer handle supports it', () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setTimeout>;
    // Test-only timer shim: enough surface for the scheduler to call `unref`.
    const setTimeoutFn = vi.fn((
      _callback: Parameters<typeof setTimeout>[0],
      _delayMs?: number,
      ..._args: unknown[]
    ) => timer) as unknown as typeof setTimeout;

    scheduleRuntimeAuthFailureReportOutboxDrainToDaemon({
      delayMs: 10,
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
      drain: vi.fn(async () => ({ delivered: 0, dropped: 0, retried: 0 })),
    });

    expect(unref).toHaveBeenCalledOnce();
  });
});
