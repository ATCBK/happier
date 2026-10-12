import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { startSingleFlightIntervalLoop } from './singleFlightIntervalLoop';

describe('startSingleFlightIntervalLoop', () => {
  it('parks with no automatic deadline and wakes once on explicit demand', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => ({ nextAutomaticRunAfterMs: null }));
      const loop = startSingleFlightIntervalLoop({ intervalMs: 10, task });
      await vi.advanceTimersByTimeAsync(10);
      expect(task).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(task).toHaveBeenCalledTimes(1);
      loop.pause();
      loop.trigger();
      loop.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(task).toHaveBeenCalledTimes(2);
      await loop.stop();
    } finally { vi.useRealTimers(); }
  });

  it('runs at the exact task deadline without waking at the ordinary interval', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => ({ nextAutomaticRunAfterMs: 125 }));
      const loop = startSingleFlightIntervalLoop({ intervalMs: 50, task });
      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(124);
      expect(task).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(2);
      await loop.stop();
    } finally { vi.useRealTimers(); }
  });

  it.each([0, -1, Number.NaN])('retains the ordinary interval for an invalid task delay (%s)', async delay => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => ({ nextAutomaticRunAfterMs: delay }));
      const loop = startSingleFlightIntervalLoop({ intervalMs: 50, task });
      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(task).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(2);
      await loop.stop();
    } finally { vi.useRealTimers(); }
  });

  it('rearms a deadline beyond the native timer range without running the task early', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => ({ nextAutomaticRunAfterMs: 2_147_483_747 }));
      const loop = startSingleFlightIntervalLoop({ intervalMs: 50, task });
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(task).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(task).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(2);
      await loop.stop();
    } finally { vi.useRealTimers(); }
  });
  it('never overlaps task executions (single-flight)', async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred();
      const second = createDeferred();
      let callCount = 0;
      const task = vi.fn(
        () => {
          callCount += 1;
          return callCount === 1 ? first.promise : second.promise;
        },
      );

      startSingleFlightIntervalLoop({
        intervalMs: 10,
        task,
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);

      first.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(20);
      expect(task).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops scheduling new ticks after stop()', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {});
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        task,
      });

      await vi.advanceTimersByTimeAsync(11);
      expect(task).toHaveBeenCalledTimes(1);

      loop.stop();
      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and waits for the active task when stop() is requested', async () => {
    vi.useFakeTimers();
    try {
      const active = createDeferred();
      const taskSignal = createDeferred<AbortSignal>();
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 60_000,
        task: async (signal) => {
          taskSignal.resolve(signal);
          await active.promise;
        },
      });

      loop.trigger();
      await vi.advanceTimersByTimeAsync(1);
      const observedSignal = await taskSignal.promise;

      let stopSettled = false;
      const stopPromise = Promise.resolve(loop.stop()).then(() => {
        stopSettled = true;
      });
      await Promise.resolve();

      expect(observedSignal.aborted).toBe(true);
      expect(stopSettled).toBe(false);

      active.resolve();
      await stopPromise;
      expect(stopSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be triggered manually without waiting for the interval', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {});
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 60_000,
        task,
      });

      loop.trigger();
      await Promise.resolve();
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses interval scheduling until resume()', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {});
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        task,
      });

      loop.pause();
      await vi.advanceTimersByTimeAsync(50);
      expect(task).not.toHaveBeenCalled();

      loop.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unrefs the interval handle when requested', () => {
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({
      unref,
    } as unknown as ReturnType<typeof setInterval>);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    try {
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        task: async () => {},
        unref: true,
      });

      expect(unref).toHaveBeenCalledTimes(1);
      loop.stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('backs off automatic retries after failures and resets after success', async () => {
    vi.useFakeTimers();
    try {
      let shouldFail = true;
      const task = vi.fn(async () => {
        if (shouldFail) {
          throw new Error('temporary outage');
        }
      });

      const loop = startSingleFlightIntervalLoop({
        intervalMs: 50,
        failureBackoffMs: 100,
        maxFailureBackoffMs: 100,
        task,
        onError: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(90);
      expect(task).toHaveBeenCalledTimes(1);

      shouldFail = false;
      await vi.advanceTimersByTimeAsync(20);
      expect(task).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(50);
      expect(task).toHaveBeenCalledTimes(3);

      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors task-requested retry-after for automatic ticks while manual trigger bypasses it', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => ({ nextAutomaticRunAfterMs: 60_000 }));
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        task,
      });

      await vi.advanceTimersByTimeAsync(11);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(task).toHaveBeenCalledTimes(1);

      loop.trigger();
      await Promise.resolve();
      expect(task).toHaveBeenCalledTimes(2);

      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual trigger bypasses failure backoff', async () => {
    vi.useFakeTimers();
    try {
      const task = vi.fn(async () => {
        throw new Error('temporary outage');
      });
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 10,
        failureBackoffMs: 60_000,
        task,
        onError: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(11);
      expect(task).toHaveBeenCalledTimes(1);

      loop.trigger();
      await Promise.resolve();
      expect(task).toHaveBeenCalledTimes(2);

      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces explicit triggers issued while a run is in flight into exactly one forced rerun', async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred();
      const task = vi.fn(() => first.promise);
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 60_000,
        task,
      });

      loop.trigger();
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(1);

      loop.trigger();
      loop.trigger();
      loop.trigger();

      first.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(2);

      loop.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(task).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() prevents a coalesced forced rerun from launching after the in-flight run settles', async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred();
      const task = vi.fn(() => first.promise);
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 60_000,
        task,
      });

      loop.trigger();
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(1);

      loop.trigger();
      loop.stop();
      first.resolve();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pause() retains a coalesced forced rerun until resume()', async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred();
      const task = vi.fn(() => first.promise);
      const loop = startSingleFlightIntervalLoop({
        intervalMs: 60_000,
        task,
      });

      loop.trigger();
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(1);

      loop.trigger();
      loop.pause();
      first.resolve();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(task).toHaveBeenCalledTimes(1);

      loop.resume();
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
