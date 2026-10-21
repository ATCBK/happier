import { createRequire } from 'node:module';
import {
  execFileWithDeadline,
  isPidPresent,
  probeProcessGroupLiveness,
} from '@happier-dev/cli-common/process';
import { createProcessCensusReader, readProcessCensus, type ProcessCensusDependencies, type ProcessStartIdentity, type ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { descendantsOf, indexCensus, protectedSet, membersOfCgroup, membersOfJob, membersOfPgid } from '@/processes/tree/processTree';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { taskkillWindowsProcessTree } from '@/subprocess/supervision/taskkillWindowsProcessTree';
import { logger } from '@/ui/logger';
import { CUSTODY_TERMINATE_TIMEOUT_MS, resolveProcessCustodySupportExecutable, terminateProcessCustodyByJob } from '@/subprocess/supervision/processCustody';

export type ProcessTreeRoot = Readonly<{
  pid?: number;
  start?: ProcessStartIdentity;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
}>;
export type ProcessTreeOptions = Readonly<{
  graceMs?: number;
  firstSignal?: 'SIGHUP' | 'SIGINT' | 'SIGTERM' | 'SIGKILL';
  tree?: boolean;
  terminateWindowsTree?: typeof taskkillWindowsProcessTree;
  /** Retained caller custody fact; a missing/recycled root still refuses discovery. */
  ownedProcessGroup?: boolean;
}>;
export type ProcessTreeTerminationInput = Readonly<{
  targets: readonly Readonly<{ pid: number; start?: ProcessStartIdentity }>[];
  tree?: boolean;
  policy?: 'stop' | 'kill';
  rootKind?: 'pty' | 'service' | 'dev_server' | 'process';
  firstSignal?: 'SIGHUP' | 'SIGINT' | 'SIGTERM' | 'SIGKILL';
  graceMs?: number;
  containment?: Readonly<{ kind: 'linux_unit'; prefix: string }> | Readonly<{ kind: 'windows_job'; name: string }>;
  /** Lifecycle owner revalidates fresh targets/membership using the canonical classifier. */
  authorizeSnapshot?: (snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>) => boolean | Promise<boolean>;
  /** Current credential, cancellation and lifecycle custody, immediately before every signal. */
  authorizeSignal?: () => boolean | Promise<boolean>;
  /** Runner lifecycle owns its existing grace/wait budget; this sends only the first signal. */
  waitForExit?: boolean;
  /** Preserve a pre-exit tree for an existing root-first graceful lifecycle. */
  captureDescendants?: boolean;
}>;
export type ProcessTreeTerminationOutcome = Readonly<{
  pid: number;
  outcome: 'ended' | 'survived' | 'gone_before' | 'refused';
  reason?: string;
  freedBytes?: number;
}>;
export type ProcessTreeTerminationResult = Readonly<{
  status: 'complete' | 'incomplete' | 'unavailable';
  outcomes: readonly ProcessTreeTerminationOutcome[];
  capturedTargets?: readonly Readonly<{ pid: number; start: ProcessStartIdentity }>[];
}>;
export type ProcessTreeCapture = Readonly<{
  status: 'ok'; capturedAtMs: number;
  capturedTargets: readonly Readonly<{ pid: number; start: ProcessStartIdentity }>[];
}> | Readonly<{ status: 'unavailable' | 'refused'; reason: string }>;
type ProcessTreeAdapters = Readonly<{
  readProcessCensus: typeof readProcessCensus;
  indexCensus: typeof indexCensus;
  descendantsOf: typeof descendantsOf;
  protectedSet: typeof protectedSet;
  membersOfCgroup: typeof membersOfCgroup;
  membersOfJob: typeof membersOfJob;
  membersOfPgid: typeof membersOfPgid;
  execFileWithDeadline: typeof execFileWithDeadline;
  isPidPresent: typeof isPidPresent;
  probeProcessGroupLiveness: typeof probeProcessGroupLiveness;
  taskkillWindowsProcessTree: typeof taskkillWindowsProcessTree;
  terminateWindowsJob: (input: Readonly<{ jobName: string; timeoutMs: number }>) => Promise<unknown>;
  windowsJobTerminationBudgetMs: number;
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  wait?: (ms: number) => Promise<void>;
}>;

// One shipped CJS owner is consumed by both the CLI and its surviving terminal launcher.
const moduleOwner = createRequire(import.meta.url)(resolveCliRuntimeAssetPath('scripts', 'process_tree.cjs')) as {
  createProcessTreeOwner(adapters: ProcessTreeAdapters): {
    terminateProcessTree(proc: ProcessTreeRoot, opts?: ProcessTreeOptions): Promise<void>;
    terminateTargets(input: ProcessTreeTerminationInput): Promise<ProcessTreeTerminationResult>;
    captureTargets(root: Readonly<{ pid: number; start?: ProcessStartIdentity }>): Promise<ProcessTreeCapture>;
  };
};
const adapters: ProcessTreeAdapters = {
  windowsJobTerminationBudgetMs: CUSTODY_TERMINATE_TIMEOUT_MS,
  readProcessCensus, indexCensus, descendantsOf, protectedSet, membersOfCgroup, membersOfJob, membersOfPgid, execFileWithDeadline, isPidPresent, probeProcessGroupLiveness, taskkillWindowsProcessTree,
  async terminateWindowsJob(input) {
    const executablePath = resolveProcessCustodySupportExecutable('win32');
    if (!executablePath) return 'unavailable';
    return await terminateProcessCustodyByJob({ executablePath, ...input });
  },
};
const owner = moduleOwner.createProcessTreeOwner(adapters);

/** Observation-only native identities, for existing root/owner lifecycle retention. */
export const captureProcessTree = owner.captureTargets;

/** System adapters use the same owner with their OS boundaries, never another signal loop. */
export function createProcessTreeTerminator(input: Readonly<{
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  wait?: (ms: number) => Promise<void>;
  censusDependencies?: ProcessCensusDependencies;
  terminateWindowsJob?: ProcessTreeAdapters['terminateWindowsJob'];
  terminateWindowsTree?: typeof taskkillWindowsProcessTree;
}> = {}): (input: ProcessTreeTerminationInput) => Promise<ProcessTreeTerminationResult> {
  const adapted = moduleOwner.createProcessTreeOwner({ ...adapters,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.kill ? { kill: input.kill } : {}),
    ...(input.wait ? { wait: input.wait } : {}),
    ...(input.terminateWindowsJob ? { terminateWindowsJob: input.terminateWindowsJob } : {}),
    ...(input.terminateWindowsTree ? { taskkillWindowsProcessTree: input.terminateWindowsTree } : {}),
    ...(input.censusDependencies ? { readProcessCensus: createProcessCensusReader(input.censusDependencies) } : {}),
  });
  return adapted.terminateTargets;
}

export function terminateProcessTree(input: ProcessTreeTerminationInput): Promise<ProcessTreeTerminationResult>;
export function terminateProcessTree(proc: ProcessTreeRoot, opts?: ProcessTreeOptions): Promise<void>;
export async function terminateProcessTree(proc: ProcessTreeRoot | ProcessTreeTerminationInput, opts?: ProcessTreeOptions): Promise<void | ProcessTreeTerminationResult> {
  try {
    if ('targets' in proc) return await owner.terminateTargets(proc);
    await owner.terminateProcessTree(proc, opts);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'plugin_exec_termination_incomplete') {
      // The CJS owner attaches its structured result; project categories without native identities.
      const result = 'result' in error ? error.result as Partial<ProcessTreeTerminationResult> : undefined;
      logger.infoFile('[process-tree] Owned process cleanup could not be verified', {
        code: 'plugin_exec_termination_incomplete',
        outcomes: [...new Set(result?.outcomes?.map(row => row.outcome) ?? [])],
        reasons: [...new Set(result?.outcomes?.flatMap(row => row.reason ? [row.reason] : []) ?? [])],
      });
    }
    throw error;
  }
}

/** One owned handle shares its current attempt, retains success, and permits retry after failure. */
export function createProcessTreeStopper(
  terminate: (options?: ProcessTreeOptions) => Promise<void>,
): Readonly<{
  stop(options?: ProcessTreeOptions): Promise<void>;
  readonly currentAttempt: Promise<void> | null;
}> {
  let termination: Promise<void> | null = null;
  return {
    get currentAttempt() { return termination; },
    stop(options) {
      if (!termination) {
        const attempt = Promise.resolve().then(() => terminate(options));
        const guardedAttempt = attempt.catch((error) => {
          if (termination === guardedAttempt) termination = null;
          throw error;
        });
        termination = guardedAttempt;
      }
      return termination;
    },
  };
}
