import type { Settings } from '@/persistence';

import { restartAllSessionRunnersOnCurrentRuntime } from './restartSessionRunnerOnCurrentRuntime';

type RestartAllInput = Parameters<typeof restartAllSessionRunnersOnCurrentRuntime>[0];
export type RestartStaleRunnersAfterDaemonStartOutcome =
  | Readonly<{ status: 'disabled' | 'shutting_down' | 'failed' }>
  | Readonly<{ status: 'completed'; result: Awaited<ReturnType<typeof restartAllSessionRunnersOnCurrentRuntime>> }>;

export async function restartStaleRunnersAfterDaemonStart(input: Readonly<{
  readSettings: () => Promise<Pick<Settings, 'restartSessionRunnersOnUpdate'>>;
  isShuttingDown: () => boolean;
  restart: () => Omit<RestartAllInput, 'mode' | 'reason' | 'shouldContinue'>;
  logDebug: (message: string, payload?: unknown) => void;
  logWarn: (message: string, payload?: unknown) => void;
}>): Promise<RestartStaleRunnersAfterDaemonStartOutcome> {
  try {
    const settings = await input.readSettings();
    if (settings.restartSessionRunnersOnUpdate !== true) return { status: 'disabled' } as const;
    if (input.isShuttingDown()) return { status: 'shutting_down' } as const;
    const result = await restartAllSessionRunnersOnCurrentRuntime({
      ...input.restart(),
      mode: 'if_stale',
      reason: 'restart_session_runners_on_update_config',
      shouldContinue: () => !input.isShuttingDown(),
    });
    const summary = {
      requestedCount: result.requestedCount, restartedCount: result.restartedCount,
      skippedCount: result.skippedCount, failedCount: result.failedCount,
      results: result.results.map(entry => ({ sessionId: entry.sessionId, status: entry.status,
        ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) })),
    };
    if (result.failedCount > 0) input.logWarn('[DAEMON RUN] Automatic startup runner refresh had failures', summary);
    else input.logDebug('[DAEMON RUN] Automatic startup runner refresh finished', summary);
    return { status: 'completed', result } as const;
  } catch (error) {
    input.logWarn('[DAEMON RUN] Automatic startup runner refresh failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'failed' } as const;
  }
}
