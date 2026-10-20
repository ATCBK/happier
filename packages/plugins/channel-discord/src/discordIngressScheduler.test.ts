import { describe, expect, it } from 'vitest';

import {
  DiscordIngressCancelledError,
  createDiscordIngressScheduler,
} from './discordIngressScheduler.js';

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Discord inbound scheduler', () => {
  it('starts independent lanes beyond the former eight-task pool', async () => {
    const scheduler = createDiscordIngressScheduler();
    const release = deferred<void>();
    const started: number[] = [];
    const results = Array.from({ length: 10 }, (_, index) => scheduler.schedule({
      connectionId: index === 9 ? 'connection-b' : 'connection-a',
      endpointId: `discord:channel:${index === 9 ? 0 : index}`,
      async run() {
        started.push(index);
        await release.promise;
      },
    }));
    const startedBeforeRelease = [...started];
    release.resolve();
    await Promise.all(results);
    expect(startedBeforeRelease).toEqual(Array.from({ length: 10 }, (_, index) => index));
  });

  it('retains a busy endpoint backlog beyond the former lane and aggregate caps in arrival order', async () => {
    const scheduler = createDiscordIngressScheduler();
    const release = deferred<void>();
    const started: number[] = [];
    const results = Array.from({ length: 514 }, (_, index) => scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      async run() {
        started.push(index);
        if (index === 0) await release.promise;
        return index;
      },
    }));
    const settled = Promise.allSettled(results);
    expect(started).toEqual([0]);
    release.resolve();
    expect(await settled).toEqual(Array.from({ length: 514 }, (_, index) => ({ status: 'fulfilled', value: index })));
    expect(started).toEqual(Array.from({ length: 514 }, (_, index) => index));
  });

  it('retains aggregate queued work across endpoints beyond the former global cap', async () => {
    const scheduler = createDiscordIngressScheduler();
    const release = deferred<void>();
    const results = Array.from({ length: 9 }, (_, lane) => Array.from({ length: 65 }, (_, index) => scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: `discord:channel:${lane}`,
      async run() {
        if (index === 0) await release.promise;
        return `${lane}:${index}`;
      },
    }))).flat();
    const settled = Promise.allSettled(results);
    release.resolve();
    expect(await settled).toEqual(Array.from({ length: 9 }, (_, lane) => Array.from({ length: 65 }, (_, index) => ({
      status: 'fulfilled', value: `${lane}:${index}`,
    }))).flat());
  });

  it('serializes one connection and endpoint lane while preserving that lane’s order', async () => {
    const scheduler = createDiscordIngressScheduler();
    const first = deferred<void>();
    const started: string[] = [];

    const firstResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        started.push('first');
        await first.promise;
        return 'first-result';
      },
    });
    const secondResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        started.push('second');
        return 'second-result';
      },
    });

    expect(started).toEqual(['first']);
    first.resolve();
    await expect(firstResult).resolves.toBe('first-result');
    await expect(secondResult).resolves.toBe('second-result');
    expect(started).toEqual(['first', 'second']);
  });

  it('continues a lane after synchronous and asynchronous task failure', async () => {
    const scheduler = createDiscordIngressScheduler();
    const first = deferred<void>();
    const route = {
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
    };
    const synchronousFailure = new Error('synchronous failure');
    const asynchronousFailure = new Error('asynchronous failure');
    const results = [
      scheduler.schedule({ ...route, run: () => first.promise }),
      scheduler.schedule({ ...route, run() { throw synchronousFailure; } }),
      scheduler.schedule({ ...route, async run() { throw asynchronousFailure; } }),
      scheduler.schedule({ ...route, run: () => 'recovered' }),
    ];
    const settled = Promise.allSettled(results);
    first.resolve();
    expect(await settled).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: synchronousFailure },
      { status: 'rejected', reason: asynchronousFailure },
      { status: 'fulfilled', value: 'recovered' },
    ]);
    await expect(scheduler.schedule({ ...route, run: () => 'next' })).resolves.toBe('next');
  });

  it('lets another endpoint progress while a busy endpoint retains its own arrival order', async () => {
    const scheduler = createDiscordIngressScheduler();
    const first = deferred<void>();
    const second = deferred<void>();
    const secondStarted = deferred<void>();
    const started: string[] = [];

    const firstResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        started.push('one-first');
        await first.promise;
        return 'one-first-result';
      },
    });
    const oneQueued = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        started.push('one-second');
        return 'one-second-result';
      },
    });
    const twoQueued = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:two',
      run: async () => {
        started.push('two-first');
        secondStarted.resolve();
        await second.promise;
        return 'two-first-result';
      },
    });

    await secondStarted.promise;
    expect(started).toEqual(['one-first', 'two-first']);
    second.resolve();
    await expect(twoQueued).resolves.toBe('two-first-result');
    expect(started).toEqual(['one-first', 'two-first']);
    first.resolve();
    await expect(firstResult).resolves.toBe('one-first-result');
    await expect(oneQueued).resolves.toBe('one-second-result');
    expect(started).toEqual(['one-first', 'two-first', 'one-second']);
  });

  it('cancels queued work before it can enter a later current lane', async () => {
    const scheduler = createDiscordIngressScheduler();
    const first = deferred<void>();
    const controller = new AbortController();
    let cancelledTaskRan = false;
    const firstResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      run: async () => {
        await first.promise;
        return 'first-result';
      },
    });
    const cancelledResult = scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      signal: controller.signal,
      run: async () => {
        cancelledTaskRan = true;
        return 'cancelled-result';
      },
    });

    controller.abort();
    await expect(cancelledResult).rejects.toBeInstanceOf(DiscordIngressCancelledError);
    await expect(scheduler.schedule({
      connectionId: 'connection-a',
      endpointId: 'discord:channel:one',
      signal: controller.signal,
      run() { cancelledTaskRan = true; },
    })).rejects.toBeInstanceOf(DiscordIngressCancelledError);
    first.resolve();
    await expect(firstResult).resolves.toBe('first-result');
    expect(cancelledTaskRan).toBe(false);
  });
});
