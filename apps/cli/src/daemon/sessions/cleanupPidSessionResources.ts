import { logger } from '@/ui/logger';

export function registerPidSpawnResourceCleanup(params: Readonly<{
  pid: number;
  /** Existing operation kind; never a credential, path, or native error text. */
  label?: string;
  spawnResourceCleanupByPid:
    Map<number, () => void | Promise<void>>;
  isCurrentPidOwner: () => boolean;
  cleanup: () => void | Promise<void>;
}>): (() => void) | null {
  if (!params.isCurrentPidOwner()) return null;
  const previousCleanup =
    params.spawnResourceCleanupByPid.get(params.pid) ?? null;
  let cleanupStarted = false;
  let cleanupCompleted = false;
  let cleanupPromise: Promise<void> | null = null;
  const registeredCleanup = async (): Promise<void> => {
    cleanupStarted = true;
    cleanupPromise ??= Promise.resolve().then(async () => {
      if (!cleanupCompleted) {
        try {
          await params.cleanup();
        } catch (error) {
          if (!params.label) throw error;
          throw new Error(`Session resource cleanup failed: ${params.label}`, { cause: error });
        }
        cleanupCompleted = true;
      }
      await previousCleanup?.();
    }).catch((error: unknown) => {
      // Retain failed custody for the next explicit attempt, while concurrent
      // callers join this attempt and completed stages stay retired.
      cleanupPromise = null;
      throw error;
    });
    await cleanupPromise;
  };
  params.spawnResourceCleanupByPid.set(params.pid, registeredCleanup);
  if (!params.isCurrentPidOwner()) {
    if (
      params.spawnResourceCleanupByPid.get(params.pid)
      === registeredCleanup
    ) {
      if (previousCleanup) {
        params.spawnResourceCleanupByPid.set(
          params.pid,
          previousCleanup,
        );
      } else {
        params.spawnResourceCleanupByPid.delete(params.pid);
      }
    }
    return null;
  }

  return () => {
    if (
      cleanupStarted
      || params.spawnResourceCleanupByPid.get(params.pid)
        !== registeredCleanup
    ) {
      return;
    }
    if (previousCleanup) {
      params.spawnResourceCleanupByPid.set(params.pid, previousCleanup);
    } else {
      params.spawnResourceCleanupByPid.delete(params.pid);
    }
  };
}

export async function retireUpstreamAuthorityBeforeProcessStop(
  params: Readonly<{
    pid: number;
    spawnResourceCleanupByPid:
      Map<number, () => void | Promise<void>>;
  }>,
): Promise<boolean> {
  const cleanup = params.spawnResourceCleanupByPid.get(params.pid);
  if (!cleanup) return true;
  try {
    await cleanup();
  } catch (error) {
    logger.debug(
      '[DAEMON RUN] Failed to retire upstream authority before process stop',
      { pid: params.pid, error },
    );
    return false;
  }
  if (params.spawnResourceCleanupByPid.get(params.pid) === cleanup) {
    params.spawnResourceCleanupByPid.delete(params.pid);
  }
  return true;
}

export async function cleanupPidSessionResources(params: Readonly<{
  pid: number;
  spawnResourceCleanupByPid: Map<number, () => void | Promise<void>>;
  sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
}>): Promise<boolean> {
  const { pid, spawnResourceCleanupByPid, sessionAttachCleanupByPid } = params;

  const attachCleanup = sessionAttachCleanupByPid.get(pid);
  const authorityRetired =
    await retireUpstreamAuthorityBeforeProcessStop({
      pid,
      spawnResourceCleanupByPid,
    });
  if (!authorityRetired) return false;

  if (attachCleanup && sessionAttachCleanupByPid.get(pid) === attachCleanup) {
    try {
      await attachCleanup();
      if (sessionAttachCleanupByPid.get(pid) === attachCleanup) {
        sessionAttachCleanupByPid.delete(pid);
      }
    } catch (error) {
      logger.debug('[DAEMON RUN] Failed to cleanup session attach file', error);
      return false;
    }
  }
  return true;
}
