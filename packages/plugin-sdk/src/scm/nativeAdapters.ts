/** @moduleRealm daemon */
import { createGitTemporaryIndex as createSharedGitTemporaryIndex, resolveGitIndexPath as resolveSharedGitIndexPath } from '@happier-dev/cli-common/scm/gitTemporaryIndex';

export type GitTemporaryIndexCommand = Readonly<{ cwd: string; args: readonly string[]; stdin?: string; env?: Record<string, string | undefined> }>;
export type GitTemporaryIndexCommandResult = Readonly<{ success: boolean; stdout: string; stderr: string; exitCode: number }>;
export type GitTemporaryIndexCommandAdapter = (input: GitTemporaryIndexCommand) => Promise<GitTemporaryIndexCommandResult>;
export type GitTemporaryIndexSeed = Readonly<{ kind: 'empty' }> | Readonly<{ kind: 'tree'; treeOid: string }> | Readonly<{ kind: 'current-index' }>;
export type GitTemporaryIndex = Readonly<{ indexPath: string; env: Record<string, string>; cleanup: () => void }>;
export type GitTemporaryIndexFailure = Readonly<{ success: false; error: string; commandResult?: GitTemporaryIndexCommandResult }>;

// The public seam preserves the shared implementation and its injected Git IO;
// private workspace package names never become author declaration dependencies.
export const createGitTemporaryIndex: (input: Readonly<{
    cwd: string; runGit: GitTemporaryIndexCommandAdapter; seed: GitTemporaryIndexSeed;
}>) => Promise<Readonly<{ success: true; tempIndex: GitTemporaryIndex }> | GitTemporaryIndexFailure> = createSharedGitTemporaryIndex;
export const resolveGitIndexPath: (input: Readonly<{
    cwd: string; runGit: GitTemporaryIndexCommandAdapter;
}>) => Promise<Readonly<{ success: true; indexPath: string }> | GitTemporaryIndexFailure> = resolveSharedGitIndexPath;
