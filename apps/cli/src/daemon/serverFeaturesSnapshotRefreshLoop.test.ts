import { afterEach, describe, expect, it, vi } from 'vitest';

import { startServerFeaturesSnapshotRefreshLoop } from './serverFeaturesSnapshotRefreshLoop';

describe('startServerFeaturesSnapshotRefreshLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parks after Home indexing settles and refreshes on the next connection change', async () => {
    vi.useFakeTimers();
    let transitionActive = true;
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 2) transitionActive = false;
    });
    const loop = startServerFeaturesSnapshotRefreshLoop({
      refresh,
      isTransitionActive: () => transitionActive,
      transitionIntervalMs: 30_000,
    });

    await vi.runAllTicks();
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    transitionActive = true;
    await loop.refresh();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    transitionActive = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    loop.stop();
  });

  it('joins a connection refresh and never rearms after stopping an in-flight refresh', async () => {
    vi.useFakeTimers();
    let finishRefresh!: () => void;
    const heldRefresh = new Promise<void>((resolve) => { finishRefresh = resolve; });
    const refresh = vi.fn(async () => { await heldRefresh; });
    const loop = startServerFeaturesSnapshotRefreshLoop({
      refresh,
      isTransitionActive: () => true,
      transitionIntervalMs: 30_000,
    });
    const first = loop.refresh();
    const second = loop.refresh();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    loop.stop();
    finishRefresh();
    await first;
    expect(vi.getTimerCount()).toBe(0);
    await loop.refresh();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('cancels the pending one-shot refresh when stopped', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const loop = startServerFeaturesSnapshotRefreshLoop({
      refresh,
      isTransitionActive: () => true,
      transitionIntervalMs: 30_000,
    });

    await vi.runAllTicks();
    expect(refresh).toHaveBeenCalledOnce();
    loop.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
