import { spawnSleepyDetachedProcess } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

/**
 * A disposable daemon-shaped OS process for state-file fixtures. The real process
 * inspector classifies its command and PID; no lifecycle classification is replaced.
 */
export function spawnDaemonLifecycleOwner() {
  return spawnSleepyDetachedProcess(['@happier-dev/cli', 'daemon', 'start-sync']);
}
