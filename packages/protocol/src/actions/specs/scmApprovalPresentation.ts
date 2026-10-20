/**
 * How a source-control approval or confirmation reads to the person deciding it: the exact files
 * affected and, for irreversible effects, that they cannot be restored. The Action specs keep their
 * technical descriptions for agents and forms. Without a summary the confirmation would repeat the
 * Action title as its own body.
 */
import { describeWorkspaceRelativePath } from './filesystemApprovalPresentation.js';
import { ScmChangeDiscardRequestSchema } from '../../scm/index.js';

const NAMED_FILE_LIMIT = 3;

function readDiscardPaths(input: unknown): string[] {
  const entries = input && typeof input === 'object' ? (input as { entries?: unknown }).entries : null;
  if (!Array.isArray(entries)) return [];
  const paths: string[] = [];
  for (const entry of entries) {
    const path = entry && typeof entry === 'object' ? (entry as { path?: unknown }).path : null;
    const named = typeof path === 'string' ? describeWorkspaceRelativePath(null, path) : null;
    if (named) paths.push(named);
  }
  return paths;
}

/** "Discard your changes to a.ts." then, on its own line, "This can’t be undone." For many files, the first three are named. */
export function describeScmChangeDiscardApprovalSummary(input: unknown): string | null {
  const paths = readDiscardPaths(input);
  const [first, second, third] = paths;
  if (!first) return null;
  const parsed = ScmChangeDiscardRequestSchema.safeParse(input);
  const entries = parsed.success ? parsed.data.entries : [];
  if (entries.length && entries.every(entry => entry.kind === 'comparison')) {
    return entries.map((entry, index) => {
      if (entry.kind !== 'comparison') return '';
      const count = Array.isArray(entry.changeKeys) ? entry.changeKeys.length : Array.isArray(entry.changeRefs) ? entry.changeRefs.length : null;
      if (count !== null) return `Revert ${count} ${count === 1 ? 'change' : 'changes'} in ${paths[index]}.`;
      const source = entry.against?.source;
      return source?.kind === 'turnCheckpoint' && source.turnId
        ? `Restore ${paths[index]} to before turn ${source.turnId}.` : `Restore ${paths[index]} to its comparison before state.`;
    }).join('\n');
  }
  const undone = 'This can’t be undone.';
  if (paths.length === 1) return `Discard your changes to ${first}.\n${undone}`;
  if (paths.length === 2) return `Discard your changes to ${first} and ${second}.\n${undone}`;
  if (paths.length === NAMED_FILE_LIMIT) return `Discard your changes to ${first}, ${second} and ${third}.\n${undone}`;
  const more = paths.length - NAMED_FILE_LIMIT;
  return `Discard your changes to ${paths.length} files: ${first}, ${second}, ${third} and ${more} more.\n${undone}`;
}

function readNonEmptyString(input: unknown, key: string): string | null {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const OPERATION_LABELS: Readonly<Record<string, string>> = {
  merge: 'merge', rebase: 'rebase', revert: 'revert', cherry_pick: 'cherry-pick',
};

/** "Merge topic into your current branch." */
export function describeScmBranchMergeApprovalSummary(input: unknown): string | null {
  const source = readNonEmptyString(input, 'sourceRef');
  return source ? `Merge ${source} into your current branch.` : null;
}

/** "Rebase your current branch onto topic." then, on its own line, that its commits are rewritten. */
export function describeScmBranchRebaseApprovalSummary(input: unknown): string | null {
  const source = readNonEmptyString(input, 'sourceRef');
  return source ? `Rebase your current branch onto ${source}.\nThis rewrites the commits on this branch.` : null;
}

/** "Skip this step of the rebase in progress." then, on its own line, what is left out. */
export function describeScmBranchOperationSkipApprovalSummary(input: unknown): string | null {
  const operation = readNonEmptyString(input, 'operation');
  const label = operation ? OPERATION_LABELS[operation] : undefined;
  return label ? `Skip this step of the ${label} in progress.\nThe changes it was applying are left out.` : null;
}

export function describeScmWorktreePruneApprovalSummary(): string {
  return 'Forget worktrees whose folders no longer exist.\nWorktrees that are still there are left alone.';
}

/** "Remove the worktree at <folder>." then, on its own line, that its folder is deleted for good. */
export function describeScmWorktreeRemoveApprovalSummary(input: unknown): string | null {
  const path = readNonEmptyString(input, 'worktreePath');
  return path ? `Remove the worktree at ${path}.\nIts folder is deleted and this can’t be undone.` : null;
}

/** "Abort the merge in progress." then, on its own line, that the resolution so far is thrown away. */
export function describeScmBranchOperationAbortApprovalSummary(input: unknown): string | null {
  const operation = readNonEmptyString(input, 'operation');
  const label = operation ? OPERATION_LABELS[operation] : undefined;
  return label ? `Abort the ${label} in progress.\nThe resolution so far is thrown away and this can’t be undone.` : null;
}

/** "Delete stash@{0}." then, on its own line, that the stashed changes are lost. */
export function describeScmStashDropApprovalSummary(input: unknown): string | null {
  const ref = readNonEmptyString(input, 'stashRef');
  return ref ? `Delete ${ref}.\nThe changes saved in it are lost and this can’t be undone.` : null;
}

function describeRemoteTarget(input: unknown): string | null {
  const remote = readNonEmptyString(input, 'remote');
  const branch = readNonEmptyString(input, 'branch');
  return remote && branch ? `${remote}/${branch}` : remote;
}

/** "Pull origin/main into your current branch." */
export function describeScmRemotePullApprovalSummary(input: unknown): string {
  const target = describeRemoteTarget(input);
  return target ? `Pull ${target} into your current branch.` : 'Pull the latest changes into your current branch.';
}

/**
 * "Push your commits to origin/main." For a force push with lease, the commits other people pushed
 * since the observed remote position can be replaced, so it reads as the replacement it is.
 */
export function describeScmRemotePushApprovalSummary(input: unknown): string {
  const target = describeRemoteTarget(input);
  if (readNonEmptyString(input, 'pushMode') === 'force_with_lease') {
    const oid = readNonEmptyString(input, 'expectedRemoteOid');
    return `Replace ${target ?? 'the remote branch'} with your local history${oid ? ` only if it still points to ${oid.slice(0, 7)}` : ''}.\nOther people’s commits may be removed from that branch. If it has changed, Git refuses the push.`;
  }
  return target ? `Push your commits to ${target}.` : 'Push your commits to the remote.';
}

/** A force push with lease replaces remote history, so it is confirmed whatever the person's remote-confirmation preference. */
export function isScmRemoteForcePush(input: unknown): boolean {
  return readNonEmptyString(input, 'pushMode') === 'force_with_lease';
}
