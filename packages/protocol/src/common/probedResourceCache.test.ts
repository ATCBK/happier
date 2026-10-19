import { describe, expect, it, vi } from 'vitest';

import { ProbedResourceCache } from './probedResourceCache.js';

describe('ProbedResourceCache', () => {
  it('cancels only the last joined consumer and permits a fresh attempt without a reply', async () => {
    const cache = new ProbedResourceCache<string>({ staleTimeMs: 0, errorCooldownMs: 100 });
    const first = new AbortController();
    const second = new AbortController();
    let probeSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (signal: AbortSignal) => {
      probeSignal = signal;
      return await new Promise<string>(() => {});
    });
    const a = cache.ensure('k', fetcher, { signal: first.signal });
    const b = cache.ensure('k', fetcher, { signal: second.signal });
    first.abort();
    expect(probeSignal?.aborted).toBe(false);
    second.abort();
    expect(probeSignal?.aborted).toBe(true);
    await expect(Promise.all([a, b])).resolves.toEqual([null, null]);
    expect(cache.getSnapshot('k')).toMatchObject({ phase: 'idle', error: null });
    await expect(cache.ensure('k', async () => 'retried')).resolves.toBe('retried');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a joined survivor live and refuses stale publication after cancellation', async () => {
    const cache = new ProbedResourceCache<string>({ staleTimeMs: 0, errorCooldownMs: 100 });
    const first = new AbortController();
    const second = new AbortController();
    let resolveProbe!: (value: string) => void;
    const fetcher = async () => await new Promise<string>((resolve) => { resolveProbe = resolve; });
    const a = cache.ensure('k', fetcher, { signal: first.signal });
    const b = cache.ensure('k', fetcher, { signal: second.signal });
    first.abort();
    resolveProbe('shared');
    await expect(a).resolves.toBeNull();
    await expect(b).resolves.toBe('shared');

    const retired = new AbortController();
    const stale = cache.ensure('k', fetcher, { force: true, signal: retired.signal });
    retired.abort();
    await cache.ensure('k', async () => 'current', { force: true });
    resolveProbe('stale');
    await stale;
    await Promise.resolve();
    expect(cache.getSnapshot('k').data).toBe('current');
  });

  it('retains an unscoped consumer when a scoped consumer leaves and handles a synchronous failure', async () => {
    const cache = new ProbedResourceCache<string>({ staleTimeMs: 0, errorCooldownMs: 100 });
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    let resolveProbe!: (value: string) => void;
    const unscoped = cache.ensure('k', async (probeSignal) => {
      signal = probeSignal;
      return await new Promise<string>((resolve) => { resolveProbe = resolve; });
    });
    const scoped = cache.ensure('k', async () => 'unused', { signal: controller.signal });
    controller.abort();
    expect(signal?.aborted).toBe(false);
    resolveProbe('answer');
    await expect(unscoped).resolves.toBe('answer');
    await expect(scoped).resolves.toBeNull();
    const failure = new Error('failed before returning a promise');
    await cache.ensure('failed', () => { throw failure; });
    expect(cache.getSnapshot('failed')).toMatchObject({ phase: 'idle', error: failure });
  });

  it('does not resurrect an invalidated entry when its live consumer receives a late answer', async () => {
    const cache = new ProbedResourceCache<string>({ staleTimeMs: 0, errorCooldownMs: 100 });
    let resolveProbe!: (value: string) => void;
    const answer = cache.ensure('k', async () => await new Promise<string>((resolve) => { resolveProbe = resolve; }));
    cache.delete('k');
    resolveProbe('answer');
    await expect(answer).resolves.toBe('answer');
    expect(cache.read('k')).toBeNull();
  });

  it('keeps existing data while refreshing (SWR)', async () => {
    let now = 0;
    const cache = new ProbedResourceCache<string>({
      staleTimeMs: 10,
      errorCooldownMs: 100,
      nowMs: () => now,
    });

    cache.setSuccess('k', 'old');
    now = 25;

    let resolveFetch!: (v: string) => void;
    const fetcher = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p = cache.ensure('k', fetcher);
    const snapDuring = cache.getSnapshot('k');
    expect(snapDuring.phase).toBe('refreshing');
    expect(snapDuring.data).toBe('old');

    resolveFetch('new');
    await p;

    const snapAfter = cache.getSnapshot('k');
    expect(snapAfter.phase).toBe('idle');
    expect(snapAfter.data).toBe('new');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent refreshes per key', async () => {
    let now = 0;
    const cache = new ProbedResourceCache<number>({
      staleTimeMs: 0,
      errorCooldownMs: 100,
      nowMs: () => now,
    });

    let resolveFetch!: (v: number) => void;
    const fetcher = vi.fn(
      async () =>
        await new Promise<number>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const p1 = cache.ensure('k', fetcher);
    const p2 = cache.ensure('k', fetcher);

    expect(cache.getSnapshot('k').phase).toBe('loading');
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch(42);
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe(42);
    expect(b).toBe(42);
  });

  it('respects error cooldown for auto refresh; force bypasses', async () => {
    let now = 0;
    const cache = new ProbedResourceCache<string>({
      staleTimeMs: 0,
      errorCooldownMs: 100,
      nowMs: () => now,
    });

    const failingFetcher = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(cache.ensure('k', failingFetcher)).resolves.toBeNull();
    expect(failingFetcher).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot('k').error).toBeTruthy();

    now = 50;
    const succeedingFetcher = vi.fn(async () => 'ok');
    await expect(cache.ensure('k', succeedingFetcher)).resolves.toBeNull();
    expect(succeedingFetcher).toHaveBeenCalledTimes(0);

    await expect(cache.ensure('k', succeedingFetcher, { force: true })).resolves.toBe('ok');
    expect(succeedingFetcher).toHaveBeenCalledTimes(1);
  });

  it('exposes keys for invalidation helpers', () => {
    const cache = new ProbedResourceCache<string>({ staleTimeMs: 10, errorCooldownMs: 10, nowMs: () => 100 });
    cache.setSuccess('a', 'x');
    cache.setError('b', new Error('nope'));
    expect(Array.from(cache.keys()).sort()).toEqual(['a', 'b']);
  });
});
