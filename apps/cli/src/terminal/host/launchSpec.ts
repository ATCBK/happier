import { readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHappierTempDir, getHappierTempDirOwnerPath } from '@happier-dev/cli-common/tempDirs';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { requireJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/requireJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { logger } from '@/ui/logger';
import { TerminalHostCreationError, type TerminalHostCreationDisposition } from '@/integrations/terminal/host/errors';
import { delay, delayUnrefAbortable } from '@/utils/time';

function ignoreMissingFile(error: unknown): void {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
}

export type TerminalLaunchSpec = Readonly<{
  argv: readonly string[];
  specPath: string;
  discard(): Promise<void>;
  /** Uses the containing startup owner's deadline and cancellation, never a separate budget. */
  awaitNativeSpawnResult?: (deadline: number, pollIntervalMs?: number, signal?: AbortSignal) => Promise<'spawned' | 'failed' | 'unknown'>;
}>;

export async function discardFailedTerminalLaunch(
  launch: Pick<TerminalLaunchSpec, 'discard'>,
  error: unknown,
  creationDisposition?: TerminalHostCreationDisposition,
): Promise<never> {
  try { await launch.discard(); }
  catch (cleanupError) {
    if (creationDisposition !== undefined) {
      throw new TerminalHostCreationError([error, cleanupError], 'Terminal launch preparation failed with incomplete cleanup', {
        creationDisposition, cleanupIncomplete: true,
      });
    }
    throw new AggregateError([error, cleanupError], 'Terminal launch and private handoff cleanup failed', { cause: error });
  }
  throw error;
}

/** A one-shot private handoff to the binary-safe terminal launcher. Passthrough policy
 * belongs to the caller: a native Agent must not inherit Herdr's Happier-runner hooks. */
export async function createTerminalLaunchSpec(input: Readonly<{
  workingDirectory: string;
  spawnArgv: readonly string[];
  spawnEnv: Readonly<Record<string, string>>;
  envPassthroughKeys: readonly string[];
  windowsVerbatimArguments?: boolean;
  reportNativeSpawn?: boolean;
}>): Promise<TerminalLaunchSpec> {
  const [command, ...args] = input.spawnArgv;
  if (!command) throw new Error('Terminal launch requires a command');
  const runtimeExecutable = await requireJavaScriptRuntimeExecutable({
    isBunRuntime: isBun(), targetLabel: 'Terminal launch',
  });
  const dir = createHappierTempDir({ purpose: 'terminal-launch' });
  const specPath = join(dir, 'launch.json');
  const spawnResultPath = input.reportNativeSpawn ? join(dir, 'native-startup.json') : undefined;
  const discard = async () => {
    const failures: unknown[] = [];
    const remove = async (operation: () => Promise<void>) => {
      try { await operation(); }
      catch (error) {
        try { ignoreMissingFile(error); } catch { failures.push(error); }
      }
    };
    await remove(() => unlink(specPath));
    if (spawnResultPath) await remove(() => unlink(spawnResultPath));
    await remove(() => rmdir(dir));
    if (failures.length === 0) await remove(() => unlink(getHappierTempDirOwnerPath(dir)));
    if (failures.length > 0) {
      logger.infoFile('[terminal] Launch artifact cleanup incomplete (terminal_launch_cleanup_incomplete)');
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, 'Terminal launch artifact cleanup incomplete');
    }
  };
  try {
    if (spawnResultPath) await writeFile(spawnResultPath, JSON.stringify({ status: 'pending' }), { mode: 0o600 });
    await writeFile(specPath, JSON.stringify({
      command, args, cwd: input.workingDirectory, env: input.spawnEnv,
      envPassthroughKeys: input.envPassthroughKeys,
      ...(input.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
      ...(spawnResultPath ? { spawnResultPath } : {}),
    }), { mode: 0o600 });
  } catch (error) {
    // Preparation has not submitted a native command. The shared cleanup owner
    // preserves that fact separately from actual cleanup completion.
    return discardFailedTerminalLaunch({ discard }, error, 'not_created');
  }
  return {
    argv: [runtimeExecutable, resolveCliRuntimeAssetPath('scripts', 'terminal_launch_spec_runner.cjs'), specPath],
    specPath, discard,
    ...(spawnResultPath ? { awaitNativeSpawnResult: async (deadline: number, pollIntervalMs = 100, signal?: AbortSignal): Promise<'spawned' | 'failed' | 'unknown'> => {
      const unknown = () => {
        logger.infoFile('[terminal] Native startup evidence unavailable (terminal_native_startup_unknown)');
        return 'unknown' as const;
      };
      for (;;) {
        if (signal?.aborted) return 'unknown';
        let result: unknown;
        try { result = JSON.parse(await readFile(spawnResultPath, 'utf8')); }
        catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) return unknown();
        }
        if (signal?.aborted) return 'unknown';
        if (result !== undefined) {
          if (!result || typeof result !== 'object' || !('status' in result)) return unknown();
          if (result.status === 'spawned' || result.status === 'failed') return result.status;
          if (result.status !== 'pending') return unknown();
        }
        if (Date.now() >= deadline) return unknown();
        const waitMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
        if (signal) await delayUnrefAbortable(waitMs, signal);
        else await delay(waitMs);
      }
    } } : {}),
  };
}
