/**
 * Daemon doctor utilities
 * 
 * Process discovery and cleanup functions for the daemon
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import { forceStopKnownDaemonPid } from './controlClient';

import { classifyProcessByPid, findRunawayHappyProcesses } from './processInspection';
import type { HappyProcessInfo } from './processInspection';
export { classifyDaemonLifecycleProcessByPid, classifyProcessByPid, classifyHappyProcess, findAllHappyProcesses, findRunawayHappyProcesses } from './processInspection';
export type { DaemonLifecycleProcessByPidClassification, HappyProcessInfo, DaemonOwnershipEnvironmentVariables, ProcessByPidClassification } from './processInspection';

export async function findHappyProcessByPid(pid: number): Promise<HappyProcessInfo | null> {
  const classified = await classifyProcessByPid(pid);
  return classified.kind === 'happy' ? classified.process : null;
}

/**
 * Stops only daemon PIDs that the canonical lifecycle owner can prove exact.
 * Explicit doctor-clean intent does not authorize signaling a PID that was
 * merely present in an earlier process inventory.
 */
export async function killRunawayHappyProcesses(): Promise<{ killed: number, errors: Array<{ pid: number, error: string }> }> {
  const runawayProcesses = await findRunawayHappyProcesses();
  const errors: Array<{ pid: number, error: string }> = [];
  let killed = 0;
  
  for (const { pid, command, type } of runawayProcesses) {
    try {
      console.log(`Killing runaway process PID ${pid}: ${command}`);
      if (type !== 'daemon' && type !== 'dev-daemon') {
        throw new Error(
          'Refusing to signal an untracked daemon-spawned process without an exact lifecycle identity',
        );
      }

      await forceStopKnownDaemonPid(pid);
      console.log(`Successfully killed runaway process PID ${pid}`);
      killed++;
    } catch (error) {
      const errorMessage = (error as Error).message;
      errors.push({ pid, error: errorMessage });
      console.log(`Failed to kill process PID ${pid}: ${errorMessage}`);
    }
  }

  return { killed, errors };
}
