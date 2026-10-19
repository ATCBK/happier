import { readProcessRunState, type ProcessRunState } from '@/daemon/processRunState';
import { logger } from '@/ui/logger';
import type { TrackedSession } from '../types';

type TrackedRunnerPid = Readonly<{ pid: number }>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

type PhysicalExitWaitParams = Readonly<{
  runners: readonly TrackedRunnerPid[];
  timeoutMs: number;
  pollIntervalMs: number;
  readRunState?: (pid: number) => Promise<ProcessRunState>;
  onExitObserved?: (pid: number, exit: Readonly<{ reason: 'process-missing'; code: null; signal: null }>) => void | Promise<void>;
}>;

export async function waitForTrackedRunnerProcessesExit(params: PhysicalExitWaitParams): Promise<boolean> {
  const readRunState = params.readRunState ?? readProcessRunState;
  const remaining = new Set(
    params.runners
      .map((runner) => runner.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  );
  if (remaining.size === 0) return true;

  const timeoutMs = Math.max(0, Math.trunc(params.timeoutMs));
  const pollIntervalMs = Math.max(0, Math.trunc(params.pollIntervalMs));
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + timeoutMs;
  do {
    for (const pid of remaining) {
      const probeStartedAtMs = Date.now();
      const runState = await readRunState(pid);
      if (runState === 'dead' || runState === 'zombie') {
        logger.infoFile('[DAEMON STOP] Tracked runner physical exit observed', {
          pid, runState, elapsedMs: Date.now() - startedAtMs, probeElapsedMs: Date.now() - probeStartedAtMs,
        });
        if (params.onExitObserved) {
          const lifecycleStartedAtMs = Date.now();
          await params.onExitObserved(pid, { reason: 'process-missing', code: null, signal: null });
          logger.infoFile('[DAEMON STOP] Tracked runner exit lifecycle completed', {
            pid, elapsedMs: Date.now() - lifecycleStartedAtMs,
          });
        }
        remaining.delete(pid);
      }
    }
    if (remaining.size === 0) return true;
    if (Date.now() >= deadlineMs) break;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadlineMs - Date.now())));
  } while (Date.now() <= deadlineMs);

  logger.infoFile('[DAEMON STOP] Physical runner exit wait expired', {
    remainingRunnerCount: remaining.size, elapsedMs: Date.now() - startedAtMs, timeoutMs,
  });
  return false;
}


export async function observePlannedRunnerRetirement(
  params: Omit<PhysicalExitWaitParams, 'runners'> & Readonly<{ tracked: TrackedSession }>,
): Promise<boolean | undefined> {
  const { tracked, ...waitOptions } = params;
  if (tracked.childProcess) return;
  // Adopted restart observation can span the full completion window. Avoid repeated process
  // listings more than twice a second while retaining an explicitly slower configured cadence.
  return await waitForTrackedRunnerProcessesExit({
    ...waitOptions,
    runners: [{ pid: tracked.pid }],
    pollIntervalMs: Math.max(params.pollIntervalMs, 500),
  });
}
