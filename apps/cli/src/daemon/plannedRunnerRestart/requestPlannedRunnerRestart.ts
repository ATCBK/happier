import { ConnectedServiceSwitchDeferralConflictError, isSameConnectedServiceSwitchTarget } from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { isPidSafeHappySessionProcess } from '../pidSafety';
import type {
  PlannedRunnerRestartDeferral,
  PlannedRunnerRestartNotSignaledReason,
  PlannedRunnerRestartSignalGateResult,
  PlannedRunnerRestartSignalRequest,
  PlannedRunnerRestartSignalResult,
} from './types';
import type { TrackedSession } from '../types';
import type { RestartSessionRunnerCompletion } from './restartSessionRunnerOnCurrentRuntime';

export type RequestPlannedRunnerRestartParams = Readonly<{
  sessionId: string;
  tracked: TrackedSession;
  completion?: Readonly<{
    hasPending: () => boolean;
    join: () => Promise<RestartSessionRunnerCompletion> | null;
    create: () => Readonly<{ promise: Promise<RestartSessionRunnerCompletion>; cancel: () => void }>;
  }>;
  observeRunnerRetirement?: (tracked: TrackedSession, sessionId: string) => void | Promise<void>;
  deferral: PlannedRunnerRestartDeferral;
  restartRequestedPids: Set<number>;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  requestSignal: (request: PlannedRunnerRestartSignalRequest) => Promise<PlannedRunnerRestartSignalResult>;
  canSignal?: () => PlannedRunnerRestartSignalGateResult | Promise<PlannedRunnerRestartSignalGateResult>;
  isProcessSafeToSignal?: (params: Readonly<{
    pid: number;
    expectedProcessCommandHash?: string;
    expectedProcessStartTimeMs?: number;
  }>) => Promise<boolean>;
  observeProcessMissing?: (tracked: TrackedSession) => void;
  clearRestartIntentForPid?: (pid: number, logMessage: string) => void;
  onSignalFailureLogMessage?: string;
  logDebug?: (message: string, payload?: unknown) => void;
  logWarn?: (message: string, payload?: unknown) => void;
}>;

function clearRestartIntent(params: Readonly<{
  pid: number;
  clearRestartIntentForPid?: (pid: number, logMessage: string) => void;
  message: string;
}>): void {
  params.clearRestartIntentForPid?.(params.pid, params.message);
}

// Capture the selected deferred callback's result, including its completion promise. A joined
// caller may resume after retirement has removed the PID reservation and settled the handoff.
class PlannedRunnerRestartExecution {
  constructor(readonly outcome: Readonly<{
    tracked: TrackedSession;
    deferral: PlannedRunnerRestartDeferral;
    signaled: boolean;
    notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
    completionPromise?: Promise<RestartSessionRunnerCompletion>;
  }>) {}
}

export async function requestPlannedRunnerRestart(
  params: RequestPlannedRunnerRestartParams,
): Promise<Readonly<{
  signaled: boolean;
  notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
  completion?: RestartSessionRunnerCompletion;
}>> {
  let signaled = false;
  let notSignaledReason: PlannedRunnerRestartNotSignaledReason | undefined;
  const isProcessSafeToSignal = params.isProcessSafeToSignal ?? isPidSafeHappySessionProcess;
  const expectedPid = params.tracked.pid;
  const expectedProcessCommandHash =
    params.tracked.processCommandHash?.trim() ?? '';
  const expectedProcessStartTimeMs = params.tracked.processStartTimeMs;
  if (
    !Number.isInteger(expectedPid)
    || expectedPid <= 0
    || !Number.isInteger(expectedProcessStartTimeMs)
    || (expectedProcessStartTimeMs ?? -1) < 0
  ) {
    return {
      signaled: false,
      notSignaledReason: 'unsafe_process',
    };
  }

  const completionState: {
    waiter?: Readonly<{ promise: Promise<RestartSessionRunnerCompletion>; cancel: () => void }>;
    promise?: Promise<RestartSessionRunnerCompletion>;
  } = {};
  let ownsReservation = false;
  const clearUnsignaledRequest = (message: string): void => {
    completionState.waiter?.cancel();
    if (!ownsReservation) return;
    ownsReservation = false;
    params.restartRequestedPids.delete(expectedPid);
    clearRestartIntent({ pid: expectedPid, clearRestartIntentForPid: params.clearRestartIntentForPid, message });
  };
  const captureExecution = () => new PlannedRunnerRestartExecution({
    tracked: params.tracked,
    deferral: params.deferral,
    signaled,
    ...(notSignaledReason ? { notSignaledReason } : {}),
    ...(completionState.promise ? { completionPromise: completionState.promise } : {}),
  });
  const runSwitch = async (): Promise<PlannedRunnerRestartExecution> => {
    const joined = params.completion?.join();
    if (joined) {
      signaled = true;
      completionState.promise = joined;
      return captureExecution();
    }
    if (params.restartRequestedPids.has(expectedPid) || params.completion?.hasPending()) {
      notSignaledReason = 'restart_already_running';
      return captureExecution();
    }
    params.restartRequestedPids.add(expectedPid);
    ownsReservation = true;
    completionState.waiter = params.completion?.create();
    completionState.promise = completionState.waiter?.promise;
    let ownerStillCurrent = true;
    let missingProcessObserved = false;
    const trackedWitnessIsCurrent = (): boolean => {
      if (!ownsReservation) return false;
      ownerStillCurrent =
        params.pidToTrackedSession.get(expectedPid) === params.tracked;
      if (!ownerStillCurrent) {
        notSignaledReason = 'stale_owner';
        return false;
      }
      if (
        params.tracked.pid !== expectedPid
        || (params.tracked.processCommandHash?.trim() ?? '')
          !== expectedProcessCommandHash
        || params.tracked.processStartTimeMs
          !== expectedProcessStartTimeMs
      ) {
        notSignaledReason = 'unsafe_process';
        return false;
      }
      return true;
    };
    const exactProcessWitnessIsCurrent = async (): Promise<boolean> => {
      if (!trackedWitnessIsCurrent()) return false;
      const safe = await isProcessSafeToSignal({
        pid: expectedPid,
        expectedProcessCommandHash,
        expectedProcessStartTimeMs,
      });
      if (!safe) {
        notSignaledReason = 'unsafe_process';
        return false;
      }
      return trackedWitnessIsCurrent();
    };
    const signalResult = await params.requestSignal({
      tracked: params.tracked,
      shouldSignal: async () => {
        if (!await exactProcessWitnessIsCurrent()) return false;
        const allowedByActivityGate = (await params.canSignal?.()) ?? true;
        if (allowedByActivityGate !== true) {
          notSignaledReason = allowedByActivityGate === false
            ? 'activity_in_progress'
            : allowedByActivityGate;
          return false;
        }
        return await exactProcessWitnessIsCurrent();
      },
      onSignalFailure: (error) => {
        clearUnsignaledRequest(params.onSignalFailureLogMessage
          ?? '[DAEMON RUN] Failed to clear planned runner restart intent after signal failure');
        params.logWarn?.(
          params.onSignalFailureLogMessage ?? '[DAEMON RUN] Failed to signal planned runner restart',
          error,
        );
      },
      onProcessAlreadyMissing: () => {
        missingProcessObserved = true;
        if (params.observeProcessMissing) {
          params.observeProcessMissing(params.tracked);
        } else {
          params.logWarn?.('[DAEMON RUN] Planned runner restart process was already missing before exit observer was ready');
        }
      },
    });

    if (!ownerStillCurrent || signalResult.status === 'skipped_stale_owner') {
      clearUnsignaledRequest('[DAEMON RUN] Failed to clear stale planned runner restart intent after skipped signal');
      if (notSignaledReason === 'unsafe_process') {
        params.logWarn?.('[DAEMON RUN] Refusing planned session runner restart because PID identity no longer matches tracked runner', {
          sessionId: params.sessionId,
          pid: expectedPid,
        });
      }
      return captureExecution();
    }

    if (signalResult.status === 'process_already_missing' && !missingProcessObserved) {
      if (params.observeProcessMissing) {
        params.observeProcessMissing(params.tracked);
      } else {
        params.logWarn?.('[DAEMON RUN] Planned runner restart process was already missing before exit observer was ready');
      }
    }

    signaled = true;
    try {
      const observation = params.observeRunnerRetirement?.(params.tracked, params.sessionId);
      if (observation) void observation.catch((error) => {
        params.logWarn?.('[DAEMON RUN] Failed to observe planned runner retirement', error);
      });
    } catch (error) {
      params.logWarn?.('[DAEMON RUN] Failed to observe planned runner retirement', error);
    }
    return captureExecution();
  };

  let selectedExecution: unknown;
  try {
    if (params.deferral.kind === 'none') {
      selectedExecution = await runSwitch();
    } else {
      selectedExecution = await params.deferral.turnDeferralQueue.requestSwitch({
        sessionId: params.sessionId,
        source: params.deferral.source,
        policy: params.deferral.policy,
        target: params.deferral.target,
        runSwitch,
      });
    }
  } catch (error) {
    if (!signaled) clearUnsignaledRequest('[DAEMON RUN] Failed to clear planned runner restart intent after request failure');
    if (error instanceof ConnectedServiceSwitchDeferralConflictError && error.code === 'switch_cancelled') {
      params.logDebug?.('[DAEMON RUN] Planned runner deferred restart superseded by a newer switch request', {
        sessionId: params.sessionId,
        deferralKind: params.deferral.kind,
      });
      return { signaled: false, notSignaledReason: 'superseded' };
    }
    throw error;
  }

  if (!(selectedExecution instanceof PlannedRunnerRestartExecution)) {
    return { signaled: false, notSignaledReason: 'restart_already_running' };
  }
  const selected = selectedExecution.outcome;
  if (selected.tracked !== params.tracked || selected.deferral.kind !== params.deferral.kind
    || (selected.deferral.kind === 'connected_service_switch' && params.deferral.kind === 'connected_service_switch'
      && !isSameConnectedServiceSwitchTarget(selected.deferral.target, params.deferral.target))) {
    return { signaled: false, notSignaledReason: 'restart_already_running' };
  }
  signaled = selected.signaled;
  notSignaledReason = selected.notSignaledReason;
  if (signaled && selected.completionPromise) {
    const completion = await selected.completionPromise;
    if (completion.ok === false && completion.diagnostics?.respawnTerminalReason === 'cancelled_before_signal') {
      return { signaled: false, notSignaledReason: 'restart_already_running' };
    }
    return { signaled: true, completion };
  }
  if (signaled || !notSignaledReason) return { signaled };
  return { signaled, notSignaledReason };
}
