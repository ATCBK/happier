import type { RpcHandlerActiveExecution } from '@/api/rpc/types';
import { performance } from 'node:perf_hooks';
import type { DoctorDaemonSelfVitals } from '@happier-dev/protocol/diagnostics/doctorSnapshot';

const SAMPLE_INTERVAL_MS = 1_000;
export const DAEMON_EVENT_LOOP_STALL_WARNING_THRESHOLD_MS = 2_000;
const MAX_REPORTED_OPERATIONS = 8;

type TimerHandle = Readonly<{ unref?: () => void }>;

export function createDaemonEventLoopStallMonitor(input: Readonly<{
  getActiveRpcOperations: () => readonly RpcHandlerActiveExecution[];
  warn: (message: string, data: Readonly<Record<string, unknown>>) => void;
  nowMs?: () => number;
  setIntervalFn?: (callback: () => void, intervalMs: number) => TimerHandle;
  clearIntervalFn?: (handle: TimerHandle) => void;
}>): Readonly<{
  start: () => void;
  stop: () => void;
  snapshot: () => DoctorDaemonSelfVitals;
}> {
  const nowMs = input.nowMs ?? (() => performance.now());
  const setIntervalFn = input.setIntervalFn
    ?? ((callback, intervalMs) => {
      const schedule: (callback: () => void, intervalMs: number) => NodeJS.Timeout = globalThis.setInterval;
      return schedule(callback, intervalMs);
    });
  const clearIntervalFn = input.clearIntervalFn
    ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  let timer: TimerHandle | null = null;
  let expectedSampleAtMs = 0;
  // Bun exposes placeholders for ELU and active handles, not measurements.
  // The existing monitor projects those as unavailable rather than healthy zeroes.
  const reportsRuntimeCounters = !process.versions.bun;
  let utilizationBaseline = reportsRuntimeCounters ? performance.eventLoopUtilization() : null;

  const sample = (): void => {
    const observedAtMs = nowMs();
    const eventLoopDelayMs = Math.max(
      0,
      Math.round(observedAtMs - expectedSampleAtMs),
    );
    expectedSampleAtMs = observedAtMs + SAMPLE_INTERVAL_MS;
    if (reportsRuntimeCounters) utilizationBaseline = performance.eventLoopUtilization();
    if (eventLoopDelayMs < DAEMON_EVENT_LOOP_STALL_WARNING_THRESHOLD_MS) return;

    const activeRpcOperations = input.getActiveRpcOperations()
      .map((operation) => ({
        method: operation.method,
        activeForMs: Math.max(0, Math.round(operation.activeForMs)),
      }))
      .sort((left, right) => right.activeForMs - left.activeForMs);
    const reportedOperations = activeRpcOperations.slice(0, MAX_REPORTED_OPERATIONS);

    input.warn('[DAEMON PERF] Event loop stall detected', {
      eventLoopDelayMs,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      activeRpcOperations: reportedOperations,
      omittedActiveRpcOperationCount: Math.max(
        0,
        activeRpcOperations.length - reportedOperations.length,
      ),
    });
  };

  return {
    start: () => {
      if (timer) return;
      if (reportsRuntimeCounters) utilizationBaseline = performance.eventLoopUtilization();
      expectedSampleAtMs = nowMs() + SAMPLE_INTERVAL_MS;
      timer = setIntervalFn(sample, SAMPLE_INTERVAL_MS);
      timer.unref?.();
    },
    stop: () => {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = null;
    },
    snapshot: () => {
      const memory = process.memoryUsage();
      // Handle enumeration is an untyped Node boundary, never inferred from timers/RPCs.
      const runtime = process as typeof process & { _getActiveHandles?: () => readonly unknown[] };
      const activeHandleCount = reportsRuntimeCounters ? runtime._getActiveHandles?.().length ?? null : null;
      return { sampledAt: Date.now(), eventLoopBusyFraction: utilizationBaseline
        ? performance.eventLoopUtilization(utilizationBaseline).utilization : null,
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, activeHandleCount,
        ...(!reportsRuntimeCounters || activeHandleCount === null ? { unavailableReason: 'runtime_not_reported' as const } : {}) };
    },
  };
}
