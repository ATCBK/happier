import type { TrackedSession } from '@/daemon/types';
import type { SessionRunnerRestartDisabledReason } from '@happier-dev/protocol';

import { isRestartCancelledBeforeSignal, type RestartCompletionWaiters } from './completionWaiters';
import type { RestartSessionRunnerCompletion } from './restartSessionRunnerOnCurrentRuntime';
import type { PlannedRunnerRestartNotSignaledReason } from './types';

type PlannedRestartSignalOutcome = Readonly<{
  signaled: boolean;
  notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
  activityDisabledReason?: SessionRunnerRestartDisabledReason;
}>;

/**
 * Restarts a session runner onto the current CLI and resolves with the respawn's completion. A request for a
 * runner whose restart is already in flight joins that restart instead of signalling again; a runner reserved
 * by another pending restart is reported as a duplicate.
 */
export async function requestVersionRuntimeRefresh(input: Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  completionWaiters: RestartCompletionWaiters;
  restartRequestedPids: ReadonlySet<number>;
  requestRestart: () => Promise<PlannedRestartSignalOutcome>;
  observeRunnerRetirement: () => void;
}>): Promise<PlannedRestartSignalOutcome & Readonly<{ completion?: RestartSessionRunnerCompletion }>> {
  // A replayed or concurrent request for a runner that is already restarting joins that restart. Signalling
  // again would hit the exiting runner, and a second waiter would orphan the first request's completion.
  const inFlight = input.completionWaiters.join(input.sessionId, input.tracked.pid);
  if (inFlight) {
    const completion = await inFlight;
    if (isRestartCancelledBeforeSignal(completion)) {
      return { signaled: false, notSignaledReason: 'duplicate_restart' };
    }
    return { signaled: true, completion };
  }
  if (input.restartRequestedPids.has(input.tracked.pid)) {
    return { signaled: false, notSignaledReason: 'duplicate_restart' };
  }
  const completionWaiter = input.completionWaiters.create(input.sessionId, input.tracked.pid);
  try {
    const restart = await input.requestRestart();
    if (!restart.signaled) {
      completionWaiter.cancel();
      return restart;
    }
    input.observeRunnerRetirement();
    return {
      ...restart,
      completion: await completionWaiter.promise,
    };
  } catch (error) {
    completionWaiter.cancel();
    throw error;
  }
}
