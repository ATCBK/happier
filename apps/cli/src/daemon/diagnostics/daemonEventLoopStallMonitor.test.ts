import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDaemonEventLoopStallMonitor } from './daemonEventLoopStallMonitor';

describe('createDaemonEventLoopStallMonitor', () => {
  beforeEach(() => { vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1'); });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each(['0', '1'])('projects on-demand process memory and measured event-loop busy share with tracing=%s', trace => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', trace);
    const monitor = createDaemonEventLoopStallMonitor({ getActiveRpcOperations: () => [], warn: () => {},
      setIntervalFn: () => ({}), clearIntervalFn: () => {} });
    monitor.start();
    try {
      const until = performance.now() + 20;
      while (performance.now() < until) { /* Real event-loop work at the runtime boundary. */ }
      const self = monitor.snapshot();
      expect(self.rssBytes).toBeGreaterThan(0);
      expect(self.heapUsedBytes).toBeGreaterThan(0);
      expect(self.heapTotalBytes).toBeGreaterThanOrEqual(self.heapUsedBytes);
      expect(self.eventLoopBusyFraction).toBeGreaterThan(0);
      expect(self.eventLoopBusyFraction).toBeLessThanOrEqual(1);
      expect(self.activeHandleCount).toBeGreaterThanOrEqual(0);
    } finally { monitor.stop(); }
  });
  it('emits a bounded safe warning when timer overshoot reaches the serious-stall threshold', () => {
    let nowMs = 10_000;
    const samples: Array<() => void> = [];
    const unref = vi.fn();
    const warn = vi.fn();
    const monitor = createDaemonEventLoopStallMonitor({
      nowMs: () => nowMs,
      setIntervalFn: (callback) => {
        samples.push(callback);
        return { unref };
      },
      clearIntervalFn: vi.fn(),
      getActiveRpcOperations: () => Array.from({ length: 9 }, (_, index) => ({
        method: `safe.method.${index}`,
        activeForMs: 9_000 - index,
      })),
      warn,
    });

    monitor.start();
    expect(unref).toHaveBeenCalledTimes(1);
    nowMs = 13_000;
    samples[0]?.();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[DAEMON PERF] Event loop stall detected',
      {
        eventLoopDelayMs: 2_000,
        sampleIntervalMs: 1_000,
        activeRpcOperations: Array.from({ length: 8 }, (_, index) => ({
          method: `safe.method.${index}`,
          activeForMs: 9_000 - index,
        })),
        omittedActiveRpcOperationCount: 1,
      },
    );

    nowMs = 14_000;
    samples[0]?.();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { trace: undefined, expectedSamples: 0 },
    { trace: '0', expectedSamples: 0 },
    { trace: '1', expectedSamples: 300 },
  ])('only samples an idle daemon on explicit performance demand (trace=$trace)', ({ trace, expectedSamples }) => {
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', trace);
    vi.useFakeTimers({ now: 10_000, toFake: ['Date', 'setInterval', 'clearInterval'] });
    let samples = 0;
    const warn = vi.fn();
    const monitor = createDaemonEventLoopStallMonitor({
      getActiveRpcOperations: () => [],
      warn,
      nowMs: Date.now,
      // Count the real owner's callbacks at the timer boundary, not a mocked monitor.
      setIntervalFn: (callback, intervalMs) => setInterval(() => {
        samples++;
        callback();
      }, intervalMs),
    });

    try {
      monitor.start();
      monitor.start();
      vi.advanceTimersByTime(300_000);
      expect(samples).toBe(expectedSamples);
      expect(vi.getTimerCount()).toBe(expectedSamples ? 1 : 0);
      expect(warn).not.toHaveBeenCalled();
      monitor.stop();
      monitor.stop();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(300_000);
      expect(samples).toBe(expectedSamples);
    } finally { monitor.stop(); }
  });
});
