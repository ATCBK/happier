import type { ProcessStartIdentity } from '@/processes/census/processCensus';
import type { SessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import type { TrackedSession } from '../types';
import type { ExactTrackedRunnerStopWitness, StopSessionOptions } from './stopSession';
import type { StopSessionResult } from './stopSessionContract';

type ExactTarget = Readonly<{ pid: number; start: ProcessStartIdentity }>;
type VerifyCurrent = () => boolean | Promise<boolean>;
type Execution = Readonly<{ signal?: AbortSignal; verifyCurrent?: VerifyCurrent }>;
type BoundRunner = ExactTrackedRunnerStopWitness & Readonly<{
  trackedPid: number;
  sessionId: string | undefined;
  runnerIdentity: TrackedSession['runnerProcessIdentity'];
}>;
export type SessionProcessActionLifecycle = Readonly<{
  prepareKill(input: Readonly<{ targets: readonly ExactTarget[] }> & Execution): Promise<(() => Promise<boolean>) | null>;
  stopExactSession(input: ExactTarget & Readonly<{ sessionId: string }> & Execution): Promise<StopSessionResult>;
}>;

/** Action intent lives on the existing tracked generation and stop/respawn owners. */
export function createSessionProcessActionLifecycle(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  markStopRequested: SessionRunnerRespawnManager['markStopRequested'];
  stopSession(sessionId: string, options?: StopSessionOptions): Promise<StopSessionResult>;
}>): SessionProcessActionLifecycle {
  const executionCurrent = async (input: Execution) => !input.signal?.aborted
    && (!input.verifyCurrent || await input.verifyCurrent()) && !input.signal?.aborted;
  function bind(target: ExactTarget): BoundRunner | null | undefined {
    const tracked = [...params.pidToTrackedSession.values()].find(row => row.pid === target.pid || row.sessionRunnerPid === target.pid);
    if (!tracked) return undefined;
    const start = tracked.pid === target.pid ? tracked.processStartTimeMs : tracked.runnerProcessIdentity?.processStartTimeMs;
    if (start === undefined || start !== target.start.startTimeMs) return null;
    return { tracked, trackedPid: tracked.pid, sessionId: tracked.happySessionId, runnerIdentity: tracked.runnerProcessIdentity,
      sessionRunnerPid: tracked.sessionRunnerPid, processStartTimeMs: tracked.processStartTimeMs,
      processCommandHash: tracked.processCommandHash };
  }
  function current(witness: BoundRunner): boolean {
    const row = witness.tracked;
    return row.pid === witness.trackedPid && params.pidToTrackedSession.get(witness.trackedPid) === row
      && row.happySessionId === witness.sessionId
      && row.runnerProcessIdentity === witness.runnerIdentity
      && row.sessionRunnerPid === witness.sessionRunnerPid
      && row.processStartTimeMs === witness.processStartTimeMs
      && row.processCommandHash === witness.processCommandHash;
  }
  return {
    async prepareKill(input) {
      let stamped = false;
      const witnesses: BoundRunner[] = [];
      for (const target of input.targets) {
        const witness = bind(target);
        if (witness === null) return null;
        if (witness && !witnesses.some(row => row.tracked === witness.tracked)) witnesses.push(witness);
      }
      const retiredWithoutReplacement = (witness: BoundRunner) => stamped
        && ![...params.pidToTrackedSession.values()].some(row => row === witness.tracked
          || row.pid === witness.trackedPid || row.sessionRunnerPid === witness.sessionRunnerPid && witness.sessionRunnerPid !== undefined
          || witness.sessionId !== undefined && row.happySessionId === witness.sessionId);
      const authorized = async () => await executionCurrent(input)
        && witnesses.every(row => current(row) || retiredWithoutReplacement(row))
        && input.targets.every(target => {
          const now = bind(target);
          return now === undefined || (now !== null && witnesses.some(row => row.tracked === now.tracked));
        });
      if (!await authorized()) return null;
      return async () => {
        if (!await authorized()) return false;
        for (const witness of witnesses) {
          if (!current(witness)) continue;
          const { tracked, sessionId } = witness;
          tracked.stopRequestedAtMs ??= Date.now();
          tracked.stopRequestedReason = 'user_process_kill';
          if (sessionId) params.markStopRequested(sessionId,
            { reason: 'user_request', requestedAtMs: tracked.stopRequestedAtMs });
        }
        stamped = true;
        return true;
      };
    },
    async stopExactSession(input) {
      const witness = bind(input);
      if (!witness || witness.tracked.happySessionId !== input.sessionId
        || !await executionCurrent(input) || !current(witness)) {
        return { status: 'incomplete', reason: 'runner_signal_incomplete' };
      }
      return await params.stopSession(input.sessionId, {
        expectedTrackedRunner: witness,
        beforeSignalExactTrackedRunner: async () => {
          if (!await executionCurrent(input) || !current(witness)) return false;
          witness.tracked.stopRequestedAtMs ??= Date.now();
          params.markStopRequested(input.sessionId,
            { reason: 'daemon_stop_session', requestedAtMs: witness.tracked.stopRequestedAtMs });
          return true;
        },
      });
    },
  };
}
