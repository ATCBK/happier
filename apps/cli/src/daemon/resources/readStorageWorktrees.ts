import type { ScmBackendRegistry } from '@/scm/registry';
import { SCM_WORKTREES_ENRICHMENT_MAX_PATHS, type ScmStatusSnapshotRequest, type ScmStatusSnapshotResponse, type ScmWorkingSnapshot,
    type ScmWorktreesEnrichmentResponse } from '@happier-dev/protocol/scm';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { readWorktreeChangeFingerprint } from '@/scm/readWorktreeChangeFingerprint';
import type { StorageWorktree } from '@/storage/categories/types';
import { join } from 'node:path';
import { WORKTREE_RELATIVE_PARENT_DIR } from '@happier-dev/protocol/scm/worktreeName';

export function readStorageWorktreePullRequestState(pr: ScmWorkingSnapshot['pullRequestStatus']): StorageWorktree['pullRequestState'] {
    const state = pr?.openPullRequest?.state;
    if (state === 'draft' || state === 'open') return 'open';
    if (state === 'closed' || state === 'merged') return state;
    if (state === 'unknown') return undefined;
    return pr?.authState === 'authenticated' || pr?.authState === 'unsupported' ? null : undefined;
}

export async function readStorageWorktrees(input: Readonly<{
    cwds: readonly string[];
    happyHomeDir?: string;
    registry?: ScmBackendRegistry;
    trashRoots?: readonly string[];
}>): Promise<readonly StorageWorktree[]> {
    if (!input.cwds.length) return [];
    return runWithScmBackendRegistryLease(input.registry, async registry => {
        const worktrees = new Map<string, StorageWorktree>();
        const visited = new Set<string>();
        for (const cwd of new Set(input.cwds)) {
            const result = await runScmRoute<ScmStatusSnapshotRequest, ScmStatusSnapshotResponse>({
                request: { cwd }, workingDirectory: cwd, registry,
                onNonRepository: () => ({ success: false }),
                runWithBackend: async ({ context, selection }) => selection.backend.statusSnapshot
                    ? selection.backend.statusSnapshot({ context, request: { cwd } }) : { success: false },
            });
            if (!result.success || !result.snapshot?.repo.rootPath) continue;
            const repositoryRoot = result.snapshot.repo.worktrees.find(worktree => worktree.isMain)?.path ?? result.snapshot.repo.rootPath;
            if (visited.has(repositoryRoot)) continue;
            visited.add(repositoryRoot);
            const managedParent = join(repositoryRoot, WORKTREE_RELATIVE_PARENT_DIR);
            const registered = result.snapshot.repo.worktrees.filter(worktree =>
                isCanonicalAbsolutePathInsideRoot(managedParent, worktree.path) && !input.trashRoots?.some(root =>
                    isCanonicalAbsolutePathInsideRoot(root, worktree.path)));
            const enriched = await runScmRoute<{ cwd: string }, ScmWorktreesEnrichmentResponse>({
                request: { cwd: repositoryRoot }, workingDirectory: repositoryRoot, registry,
                onNonRepository: () => ({ success: false, worktrees: [] }),
                runWithBackend: async ({ context, selection }) => {
                    const facts: NonNullable<StorageWorktree['facts']>[] = [];
                    for (let offset = 0; offset < registered.length; offset += SCM_WORKTREES_ENRICHMENT_MAX_PATHS) {
                        const response = await selection.backend.worktreesEnrichment?.({ context, request: {
                            cwd: repositoryRoot, worktreePaths: registered.slice(offset, offset + SCM_WORKTREES_ENRICHMENT_MAX_PATHS).map(w => w.path),
                        } });
                        if (response?.success && response.worktrees) facts.push(...response.worktrees);
                    }
                    return { success: true, worktrees: facts };
                },
            });
            const factsByPath = new Map((enriched.worktrees ?? []).map(facts => [facts.path, facts] as const));
            await Promise.all(registered.map(async worktree => {
                const [snapshot, fingerprint] = await Promise.all([
                    runScmRoute<ScmStatusSnapshotRequest, ScmStatusSnapshotResponse>({ request: { cwd: worktree.path },
                        workingDirectory: worktree.path, registry, onNonRepository: () => ({ success: false }),
                        runWithBackend: async ({ context, selection }) => selection.backend.statusSnapshot
                            ? selection.backend.statusSnapshot({ context, request: { cwd: worktree.path } }) : { success: false },
                    }), readWorktreeChangeFingerprint(worktree.path),
                ]);
                const pr = snapshot.success ? snapshot.snapshot?.pullRequestStatus : undefined;
                const pullRequestState = readStorageWorktreePullRequestState(pr);
                worktrees.set(worktree.path, { path: worktree.path, repositoryRoot, isMain: worktree.isMain,
                    facts: factsByPath.get(worktree.path), pullRequestState,
                    retentionSupported: result.snapshot?.capabilities.worktreeRetention === true,
                    ...(fingerprint.kind === 'available' ? { fingerprint: fingerprint.fingerprint } : {}),
                });
            }));
        }
        return [...worktrees.values()];
    }, { happyHomeDir: input.happyHomeDir });
}
