import type { ChildProcess } from 'node:child_process';
import { isPidPresent, isPidProvablyAbsent } from '@happier-dev/cli-common/process';

export type DaemonStartProcessObservation = Partial<Pick<ChildProcess, 'exitCode' | 'signalCode' | 'pid'>>
  & { detachedDaemonPid?: number };

export function hasObservableDaemonStartProcessExited(
  child: DaemonStartProcessObservation,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    // Windows returns the short-lived PowerShell launcher. Only the detached
    // daemon PID reported by that launcher can establish startup failure.
    return typeof child.detachedDaemonPid === 'number'
      && isPidProvablyAbsent(child.detachedDaemonPid);
  }
  return (
    child.exitCode !== null && child.exitCode !== undefined
  ) || (
    child.signalCode !== null && child.signalCode !== undefined
  );
}

export function hasObservableDaemonStartProcessRunning(
  child: DaemonStartProcessObservation,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    return typeof child.detachedDaemonPid === 'number' && isPidPresent(child.detachedDaemonPid);
  }
  return typeof child.pid === 'number' && !hasObservableDaemonStartProcessExited(child, platform);
}

export async function waitForDaemonRunningWithinBudget(params: {
  isRunning: () => Promise<boolean>;
  shouldAbort?: () => boolean;
  isStillStarting?: () => boolean | Promise<boolean>;
  onStillStarting?: () => void;
  timeoutMs: number;
  /** The first checkpoint may already have consumed time preparing the successor launch. */
  initialTimeoutMs?: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  let deadline = performance.now() + (params.initialTimeoutMs ?? params.timeoutMs);
  if (await params.isRunning()) return true;
  if (params.shouldAbort?.()) return false;

  const sleep =
    typeof params.sleep === 'function'
      ? params.sleep
      : (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  let nextPollMs = params.pollMs;
  for (;;) {
    let remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      // The startup budget is a reporting checkpoint while the owning process
      // or daemon control state still proves startup is live. Elapsed time alone
      // cannot turn that evidence into a failed start.
      if (!await params.isStillStarting?.()) return false;
      params.onStillStarting?.();
      deadline = performance.now() + params.timeoutMs;
      remainingMs = params.timeoutMs;
    }
    const sleepMs = Math.min(nextPollMs, remainingMs);
    await sleep(sleepMs);
    if (await params.isRunning()) return true;
    if (params.shouldAbort?.()) return false;
    // Startup can be slow under load. Keep the first readiness probe quick, then
    // match the stack's one-second lifecycle observation cadence on misses.
    nextPollMs = Math.min(nextPollMs * 2, 1_000);
  }
}
