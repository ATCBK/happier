import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/plugin-sdk/sessions/work-state';
import { isPermanentRequestError } from '@happier-dev/plugin-sdk/http';
import { resolveSessionMutationRetryDelayMs } from '@happier-dev/plugin-sdk/sessions';
import { createCoalescedScheduler } from '@happier-dev/plugin-sdk/async';

import type { WorkflowActivityObservationLike } from './workflowActivityObservation.js';
import type { WorkflowActivityPublisher } from './publishWorkflowActivitySnapshot.js';

/**
 * Coalescing/scheduling wrapper around the per-run workflow activity publisher (CWF3).
 *
 * The single choke point for write-rate control. It reuses the generic `createCoalescedScheduler`
 * (one in-flight drain, follow-up coalesced) and layers workflow-specific semantics on top:
 *
 * - Debounce progress-only updates with a latest-wins delay so a progress burst becomes one write.
 * - Bypass the debounce and publish immediately on UX-relevant transitions: run start, status-class
 *   change, or terminal status — so the UI discovers runs and terminal outcomes promptly.
 * - Accumulate changed run ids across notifies so the eventual publish carries every dirty run.
 * - Failed runs use session-mutation backoff; fresh observations and flushes respect that delay.
 * - `flush()` drains ready work immediately (terminal flush / stream close / session finalization).
 * - `dispose()` stops scheduling.
 *
 * Per-run fingerprint/no-op suppression already lives upstream in the tracker (it reports
 * `changedRunIds` only on material changes), so this layer never needs to diff snapshots; an empty
 * change set is simply a no-op.
 */
export type CoalescedWorkflowActivityPublisher = Readonly<{
  /** Record a tracker observation. Triggers an immediate or debounced publish. */
  notify(observation: WorkflowActivityObservationLike): void;
  /** Drain ready changes immediately, preserving failed runs' retry delay. */
  flush(): Promise<void>;
  /** Stop scheduling. */
  dispose(): void;
}>;

export function createCoalescedWorkflowActivityPublisher(params: Readonly<{
  publisher: WorkflowActivityPublisher;
  getSnapshots: () => ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}>): CoalescedWorkflowActivityPublisher {
  const debounceMs = params.debounceMs ?? 300;
  const pendingChangedRunIds = new Set<string>();
  const retriesByRun = new Map<string, Readonly<{ attempts: number; nextAttemptAt: number }>>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let activeFlushes = 0;

  const scheduler = createCoalescedScheduler({
    drain: async () => {
      if (disposed) return;
      if (pendingChangedRunIds.size === 0) return;
      const now = performance.now();
      const changedRunIds = [...pendingChangedRunIds].filter((runId) => isReady(runId, now));
      if (changedRunIds.length === 0) {
        // Native timers truncate fractional delays and may wake before a monotonic deadline.
        scheduleRetryTimer();
        return;
      }
      for (const runId of changedRunIds) pendingChangedRunIds.delete(runId);
      try {
        const result = await params.publisher.publish({
          snapshots: params.getSnapshots(),
          changedRunIds,
        });
        const failedRunIds = new Set(result.failedRunIds);
        for (const runId of changedRunIds) {
          if (!failedRunIds.has(runId)) retriesByRun.delete(runId);
        }
        scheduleRetry(result.failedRunIds);
      } catch (error) {
        if (!isPermanentRequestError(error)) {
          scheduleRetry(changedRunIds);
        } else {
          for (const runId of changedRunIds) retriesByRun.delete(runId);
          scheduleRetryTimer();
        }
        throw error;
      }
    },
    onError: params.onError,
  });

  function clearDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function triggerNow(): void {
    clearDebounce();
    scheduler.trigger();
  }

  function isReady(runId: string, now: number): boolean {
    const retry = retriesByRun.get(runId);
    return !retry || retry.nextAttemptAt <= now;
  }

  function scheduleDebounce(): void {
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scheduler.trigger();
    }, debounceMs);
  }

  function scheduleRetry(runIds: readonly string[]): void {
    if (disposed) return;
    for (const runId of runIds) {
      const attempts = retriesByRun.get(runId)?.attempts ?? 0;
      retriesByRun.set(runId, {
        attempts: attempts + 1,
        nextAttemptAt: performance.now() + resolveSessionMutationRetryDelayMs(attempts),
      });
      pendingChangedRunIds.add(runId);
    }
    scheduleRetryTimer();
  }

  function scheduleRetryTimer(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (disposed || retriesByRun.size === 0) return;
    const nextAttemptAt = Math.min(...[...retriesByRun.values()].map((retry) => retry.nextAttemptAt));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      scheduler.trigger();
    }, Math.max(0, nextAttemptAt - performance.now()));
  }

  function notify(observation: WorkflowActivityObservationLike): void {
    if (disposed) return;
    for (const runId of observation.changedRunIds) pendingChangedRunIds.add(runId);
    if (![...pendingChangedRunIds].some((runId) => isReady(runId, performance.now()))) return;

    const immediate =
      observation.startedRunIds.length > 0
      || observation.statusChangedRunIds.length > 0
      || observation.terminalRunIds.length > 0;

    if (immediate || activeFlushes > 0) {
      triggerNow();
      return;
    }
    // Progress-only: latest-wins debounce.
    scheduleDebounce();
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    clearDebounce();
    // The generic scheduler owns the only publish loop. Its flush barrier waits for an already
    // active drain and coalesces these pending ids into a follow-up, avoiding a competing direct
    // publish that could return early or race record/headline revision ownership.
    activeFlushes += 1;
    try {
      await scheduler.flush();
    } finally {
      activeFlushes -= 1;
    }
  }

  function dispose(): void {
    disposed = true;
    clearDebounce();
    pendingChangedRunIds.clear();
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    retriesByRun.clear();
    scheduler.dispose();
  }

  return { notify, flush, dispose };
}
