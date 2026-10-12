import { rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHappierTempDir, getHappierTempDirOwnerPath } from '@happier-dev/cli-common/tempDirs';

import {
  buildPosixShellCommand,
  buildPosixShellEnvironmentAssignments,
} from '@happier-dev/agents/process/shellCommand';
import { logger } from '@/ui/logger';
import { TerminalHostCreationError } from '../terminal/host/errors';

export type PreparedTmuxWindowLaunch = Readonly<{
  command: string;
  cleanup: () => Promise<void>;
}>;

/**
 * Carries window-scoped environment values through a private one-shot file so
 * they never become tmux client arguments. The child shell removes inherited
 * owned keys before invoking any helper, unlinks the file, and exports the
 * prepared environment only after readiness signaling succeeds.
 */
export async function prepareTmuxWindowLaunch(input: Readonly<{
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  unsetEnvKeys: readonly string[];
  readySignal: string;
}>): Promise<PreparedTmuxWindowLaunch> {
  const directory = createHappierTempDir({ purpose: 'tmux-window' });
  const scriptPath = join(directory, 'launch.sh');
  const cleanup = async () => {
    try {
      const ignoreMissing = (error: unknown) => {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
      };
      await unlink(scriptPath).catch(ignoreMissing);
      await rmdir(directory).catch(ignoreMissing);
      await unlink(getHappierTempDirOwnerPath(directory)).catch(ignoreMissing);
    } catch (error) {
      logger.infoFile('[tmux] Private launch cleanup incomplete (tmux_launch_cleanup_incomplete)');
      throw error;
    }
  };
  try {
    const assignments = buildPosixShellEnvironmentAssignments(input.env);
    const lines = [
      '#!/bin/sh',
      ...(input.unsetEnvKeys.length > 0 ? [`unset ${input.unsetEnvKeys.join(' ')}`] : []),
      buildPosixShellCommand(['rm', '-f', '--', scriptPath]),
      `${buildPosixShellCommand(['rmdir', '--', directory])} 2>/dev/null || true`,
      buildPosixShellCommand(['rm', '-f', '--', getHappierTempDirOwnerPath(directory)]),
      `${buildPosixShellCommand(['tmux', 'wait-for', '-S', input.readySignal])} || exit $?`,
      ...(assignments.length > 0 ? [`export ${assignments}`] : []),
      `exec ${buildPosixShellCommand(input.args)}`,
      '',
    ];
    await writeFile(scriptPath, lines.join('\n'), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });

    return {
      command: buildPosixShellCommand(['/bin/sh', scriptPath]),
      cleanup,
    };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) {
      throw new TerminalHostCreationError([error, cleanupError], 'Tmux launch preparation failed with incomplete cleanup', {
        creationDisposition: 'not_created', cleanupIncomplete: true,
      });
    }
    throw error;
  }
}
