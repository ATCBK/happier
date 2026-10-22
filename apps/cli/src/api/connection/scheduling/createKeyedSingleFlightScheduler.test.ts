import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKeyedSingleFlightScheduler } from './createKeyedSingleFlightScheduler';

describe('createKeyedSingleFlightScheduler', () => {
  function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at most once for the same key when scheduled multiple times before the delay', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 10 });
    const run = vi.fn(async () => {});

    const results = [scheduler.scheduleResult('a', run), scheduler.scheduleResult('a', run), scheduler.scheduleResult('a', run)];

    await vi.advanceTimersByTimeAsync(9);
    expect(run).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await Promise.all(results);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not start a second run for the same key while the first run is in-flight', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 10 });

    const deferred = createDeferred<void>();
    const run = vi.fn(async () => {
      await deferred.promise;
    });

    const first = scheduler.scheduleResult('a', run);
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);

    const second = scheduler.scheduleResult('a', run);
    await vi.runOnlyPendingTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);

    deferred.resolve(undefined);
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);

    const next = scheduler.scheduleResult('a', run);
    await vi.runAllTimersAsync();
    await next;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('delivers a shared failure to all borrowers and permits another acquisition', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 10 });
    const error = new Error('Lookup unavailable');
    const run = vi.fn(async () => { throw error; });
    const results = Promise.allSettled([scheduler.scheduleResult('a', run), scheduler.scheduleResult('a', run)]);
    await vi.runAllTimersAsync();
    await expect(results).resolves.toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(run).toHaveBeenCalledTimes(1);
    const next = scheduler.scheduleResult('a', async () => 'recovered');
    await vi.runAllTimersAsync();
    await expect(next).resolves.toBe('recovered');
  });

  it('shares the same result promise for duplicate result schedules', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 10 });
    const deferred = createDeferred<string>();
    const run = vi.fn(async () => deferred.promise);

    const first = scheduler.scheduleResult('a', run);
    const second = scheduler.scheduleResult('a', run);

    await vi.runOnlyPendingTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);

    deferred.resolve('ok');
    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBe('ok');
  });

  it('limits concurrent result runs across keys', async () => {
    vi.useFakeTimers();

    const scheduler = createKeyedSingleFlightScheduler({ delayMs: 0, maxConcurrent: 1 });
    const deferredA = createDeferred<string>();
    const runA = vi.fn(async () => deferredA.promise);
    const runB = vi.fn(async () => 'b');

    const first = scheduler.scheduleResult('a', runA);
    const second = scheduler.scheduleResult('b', runB);

    await vi.runAllTimersAsync();
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(0);

    deferredA.resolve('a');
    await expect(first).resolves.toBe('a');
    await vi.runAllTimersAsync();

    await expect(second).resolves.toBe('b');
    expect(runB).toHaveBeenCalledTimes(1);
  });
});
