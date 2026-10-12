import type { ScmBackend } from '../types.js';
import { runScmCommand } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { withGitWorktreeMutation } from './worktreeMutationQueue.js';

export const gitIgnoredPaths: NonNullable<ScmBackend['ignoredPaths']> = async input =>
    withGitWorktreeMutation(input.context.cwd, async () => {
        const result = await runScmCommand({ bin: 'git', cwd: input.context.cwd,
            args: ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
            env: buildScmNonInteractiveEnv(), signal: input.signal });
        return result.success ? { success: true, paths: result.stdout.split('\0').filter(Boolean) }
            : { success: false, error: result.stderr, errorCode: 'COMMAND_FAILED' };
    });
