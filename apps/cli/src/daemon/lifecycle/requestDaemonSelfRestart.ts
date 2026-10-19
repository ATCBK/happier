import { isPidPresent } from '@happier-dev/cli-common/process';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { readDaemonState } from '@/persistence';
import { logger } from '@/ui/logger';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import type { DetachedDaemonStartProcess } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { buildDaemonControlHttpHeaders } from '@/daemon/controlHttp';
import {
  hasObservableDaemonStartProcessExited,
  hasObservableDaemonStartProcessRunning,
  waitForDaemonRunningWithinBudget,
  type DaemonStartProcessObservation,
} from '@/daemon/waitForDaemonRunningWithinBudget';

export type RequestDaemonSelfRestartResult =
  | { status: 'exited' }
  | { status: 'spawn_failed'; error: unknown }
  | { status: 'replacement_not_confirmed' };

type SpawnDetachedDaemonStartSync = (
  options?: Parameters<typeof spawnDetachedDaemonStartSync>[0],
) => Promise<Partial<DetachedDaemonStartProcess>>;
type ReadDaemonState = () => Promise<DaemonLocallyPersistedState | null>;
type ConfirmReplacementDaemonState = (state: DaemonLocallyPersistedState) => Promise<boolean>;

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number | null | undefined): boolean {
  // `isPidPresent` owns "can this value even name a process", so this only narrows the type.
  return typeof pid === 'number' && isPidPresent(pid);
}

function hasAuthenticatedPingDetails(state: DaemonLocallyPersistedState): boolean {
  const httpPort = typeof state.httpPort === 'number' && Number.isFinite(state.httpPort)
    ? state.httpPort
    : null;
  const controlToken = typeof state.controlToken === 'string' ? state.controlToken.trim() : '';
  return Boolean(httpPort && controlToken);
}

async function confirmReplacementDaemonState(state: DaemonLocallyPersistedState): Promise<boolean> {
  if (!isPidAlive(state.pid)) return false;

  const httpPort = typeof state.httpPort === 'number' && Number.isFinite(state.httpPort)
    ? state.httpPort
    : null;
  const controlToken = typeof state.controlToken === 'string' ? state.controlToken.trim() : '';
  if (!httpPort || !controlToken) {
    return true;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${httpPort}/ping`, {
      method: 'POST',
      headers: buildDaemonControlHttpHeaders(controlToken),
      body: '{}',
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;

    const rawBody = await response.text();
    if (!rawBody.trim()) return true;
    const parsed = JSON.parse(rawBody) as unknown;
    return !(parsed && typeof parsed === 'object' && (parsed as { success?: unknown }).success === false);
  } catch {
    return false;
  }
}

export async function waitForReplacementDaemon(params: Readonly<{
  ownPid: number;
  expectedCliVersion: string;
  expectedRuntimeId?: string | null;
  timeoutMs: number;
  deadlineAtMs?: number;
  pollMs: number;
  startupProcess?: DaemonStartProcessObservation;
  readDaemonStateImpl?: ReadDaemonState;
  confirmReplacementStateImpl?: ConfirmReplacementDaemonState;
}>): Promise<boolean> {
  const {
    ownPid,
    expectedRuntimeId,
    timeoutMs,
    pollMs,
    readDaemonStateImpl = readDaemonState,
    confirmReplacementStateImpl = confirmReplacementDaemonState,
  } = params;
  const normalizedExpectedCliVersion = String(params.expectedCliVersion ?? '').trim();
  const normalizedExpectedRuntimeId = typeof expectedRuntimeId === 'string' ? expectedRuntimeId.trim() : '';
  const deadline = params.deadlineAtMs ?? Date.now() + timeoutMs;
  let lastObserved: Readonly<{
    pid: number;
    startedWithCliVersion?: string;
    runtimeId?: string;
    reason: string;
  }> | null = null;
  const isStillStarting = () => params.startupProcess !== undefined
    && hasObservableDaemonStartProcessRunning(params.startupProcess);
  const replacementConfirmed = (Date.now() < deadline || isStillStarting())
    && await waitForDaemonRunningWithinBudget({
      isRunning: async () => {
        const daemonState = await readDaemonStateImpl();
        if (daemonState) {
          const observed = {
            pid: daemonState.pid,
            startedWithCliVersion: daemonState.startedWithCliVersion,
            runtimeId: daemonState.runtimeId,
          };
          if (daemonState.pid === ownPid) {
            lastObserved = { ...observed, reason: 'own_pid' };
          } else if (normalizedExpectedCliVersion && daemonState.startedWithCliVersion !== normalizedExpectedCliVersion) {
            lastObserved = { ...observed, reason: 'version_mismatch' };
          } else if (normalizedExpectedRuntimeId && daemonState.runtimeId !== normalizedExpectedRuntimeId) {
            lastObserved = { ...observed, reason: 'runtime_mismatch' };
          } else if (normalizedExpectedRuntimeId && !hasAuthenticatedPingDetails(daemonState)) {
            lastObserved = { ...observed, reason: 'authenticated_ping_unavailable' };
          } else if (await confirmReplacementStateImpl(daemonState)) {
            return true;
          } else {
            lastObserved = { ...observed, reason: 'confirmation_failed' };
          }
        } else {
          lastObserved = null;
        }
        return false;
      },
      shouldAbort: () => (
        lastObserved?.pid === (params.startupProcess?.detachedDaemonPid ?? params.startupProcess?.pid)
        && (lastObserved?.reason === 'version_mismatch' || lastObserved?.reason === 'runtime_mismatch')
      ) || (
        params.startupProcess !== undefined
        && hasObservableDaemonStartProcessExited(params.startupProcess)
      ),
      isStillStarting,
      onStillStarting: () => logger.debug('[DAEMON RUN] Replacement daemon is still starting; waiting for authenticated readiness'),
      timeoutMs,
      initialTimeoutMs: Math.max(0, deadline - Date.now()),
      pollMs,
    });
  if (replacementConfirmed) return true;
  logger.debug('[DAEMON RUN] Replacement daemon confirmation ended without authenticated readiness', {
    expectedCliVersion: normalizedExpectedCliVersion || undefined,
    expectedRuntimeId: normalizedExpectedRuntimeId || undefined,
    lastObserved,
  });
  return false;
}

export async function requestDaemonSelfRestart(params: Readonly<{
  runtimeId?: string | null;
  expectedCliVersion: string;
  ownPid?: number;
  timeoutMs: number;
  deadlineAtMs?: number;
  pollMs: number;
  postConfirmationOverlapMs?: number;
  onReplacementConfirmed?: () => Promise<void>;
  takeover?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  spawnDetachedDaemonStartSyncImpl?: SpawnDetachedDaemonStartSync;
  readDaemonStateImpl?: ReadDaemonState;
  confirmReplacementStateImpl?: ConfirmReplacementDaemonState;
  exitProcess?: (code: number) => never | void;
}>): Promise<RequestDaemonSelfRestartResult> {
  const {
    expectedCliVersion,
    timeoutMs,
    pollMs,
    postConfirmationOverlapMs = 0,
    takeover = true,
    env = process.env,
    spawnDetachedDaemonStartSyncImpl = spawnDetachedDaemonStartSync,
    readDaemonStateImpl = readDaemonState,
    confirmReplacementStateImpl = confirmReplacementDaemonState,
    exitProcess = (code: number) => process.exit(code),
  } = params;

  const runtimeId = typeof params.runtimeId === 'string' ? params.runtimeId.trim() : '';
  const restartEnv: Record<string, string | undefined> = {
    ...env,
    HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
    ...(runtimeId ? { HAPPIER_DAEMON_RUNTIME_ID: runtimeId } : {}),
    ...(takeover ? { HAPPIER_DAEMON_TAKEOVER: '1' } : {}),
  };

  let spawned: Partial<DetachedDaemonStartProcess>;
  try {
    spawned = await spawnDetachedDaemonStartSyncImpl({
      startupSource: 'self-restart',
      env: restartEnv,
    });
    spawned.unref?.();
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to spawn replacement daemon for self-restart', error);
    return { status: 'spawn_failed', error };
  }

  const replacementConfirmed = await waitForReplacementDaemon({
    ownPid: params.ownPid ?? process.pid,
    expectedCliVersion,
    expectedRuntimeId: runtimeId,
    timeoutMs,
    ...(params.deadlineAtMs === undefined ? {} : { deadlineAtMs: params.deadlineAtMs }),
    pollMs,
    startupProcess: spawned,
    readDaemonStateImpl,
    confirmReplacementStateImpl,
  });
  if (!replacementConfirmed) {
    logger.debug('[DAEMON RUN] Replacement daemon was not confirmed. Keeping current daemon alive.');
    return { status: 'replacement_not_confirmed' };
  }

  logger.debug('[DAEMON RUN] Replacement daemon confirmed. Exiting current daemon process.');
  await params.onReplacementConfirmed?.();
  await delay(postConfirmationOverlapMs);
  exitProcess(0);
  return { status: 'exited' };
}
