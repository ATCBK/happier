import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { ScmBackendRegistry } from '@/scm/registry';
import { SCM_WORKTREES_ENRICHMENT_MAX_PATHS, type ScmStatusSnapshotRequest, type ScmStatusSnapshotResponse, type ScmWorkingSnapshot,
    type ScmWorktreesEnrichmentResponse } from '@happier-dev/protocol/scm';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot, resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { readWorktreeChangeFingerprint } from '@/scm/readWorktreeChangeFingerprint';
import type { StorageWorktree } from '@/storage/categories/types';
import { dirname, join } from 'node:path';
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
    /** Trusted indexed directories, inspected on demand rather than registered as Projects. */
    candidatePaths?: readonly string[];
    /** Already inspected in the caller's current snapshot; do not recapture an enclosing root. */
    knownRoots?: readonly string[];
    happyHomeDir?: string;
    registry?: ScmBackendRegistry;
    trashRoots?: readonly string[];
}>): Promise<readonly StorageWorktree[]> {
    const candidates = new Set<string>();
    for (const requested of new Set(input.candidatePaths)) {
        let path = requested;
        for (;;) {
            if (path !== requested && input.knownRoots?.some(root => canonicalAbsolutePathsEqual(root, path))) break;
            // Markers only locate the SCM consultation; they confer no cleanup authority.
            try { await lstat(join(path, '.git')); candidates.add(path); break; }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
            }
            const parent = dirname(path);
            if (parent === path) break;
            path = parent;
        }
    }
    if (!input.cwds.length && !candidates.size) return [];
    return runWithScmBackendRegistryLease(input.registry, async registry => {
        // One inspection's consumers share the same worktree evidence. A later
        // review/effect calls this owner again and receives entirely fresh facts.
        const snapshots = new Map<string, Promise<ScmStatusSnapshotResponse>>();
        const fingerprints = new Map<string, ReturnType<typeof readWorktreeChangeFingerprint>>();
        const readSnapshot = (cwd: string) => runScmRoute<ScmStatusSnapshotRequest, ScmStatusSnapshotResponse>({
            request: { cwd }, workingDirectory: cwd, registry, onNonRepository: () => ({ success: false }),
            runWithBackend: ({ context, selection }) => {
                const root = selection.detection.rootPath;
                const key = root ? resolveCanonicalAbsolutePath(root)?.comparisonKey : undefined;
                const captured = key ? snapshots.get(key) : undefined;
                if (captured) return captured;
                const current = selection.backend.statusSnapshot
                    ? Promise.resolve(selection.backend.statusSnapshot({ context, request: { cwd } })) : Promise.resolve({ success: false });
                if (key) snapshots.set(key, current);
                return current;
            },
        });
        const readFingerprint = (path: string) => {
            const key = resolveCanonicalAbsolutePath(path)?.comparisonKey ?? path;
            let current = fingerprints.get(key);
            if (!current) { current = readWorktreeChangeFingerprint(path); fingerprints.set(key, current); }
            return current;
        };
        const worktrees = new Map<string, StorageWorktree>();
        const anchors: string[] = [];
        for (const path of candidates) {
            // Unavailable/older classifiers leave an explicit Check item; no filesystem bypass.
            worktrees.set(path, { path, repositoryRoot: path });
            const selected = await registry.selectBackend({ cwd: path, workingDirectory: path, includeRetainedWorktrees: true }).catch(() => null);
            if (selected?.detection.rootPath) anchors.push(selected.detection.rootPath);
        }
        const visited = new Set<string>();
        for (const cwd of new Set([...input.cwds, ...anchors])) {
            const result = await readSnapshot(cwd);
            if (!result.success || !result.snapshot?.repo.rootPath) continue;
            const repositoryRoot = result.snapshot.repo.worktrees.find(worktree => worktree.isMain)?.path ?? result.snapshot.repo.rootPath;
            if (visited.has(repositoryRoot)) continue;
            visited.add(repositoryRoot);
            const managedParent = join(repositoryRoot, WORKTREE_RELATIVE_PARENT_DIR);
            const registered = result.snapshot.repo.worktrees.filter(worktree =>
                (worktree.isMain || isCanonicalAbsolutePathInsideRoot(managedParent, worktree.path)
                    || [...candidates].some(path => canonicalAbsolutePathsEqual(path, worktree.path))) && !input.trashRoots?.some(root =>
                    isCanonicalAbsolutePathInsideRoot(root, worktree.path)));
            const enriched = await runScmRoute<{ cwd: string }, ScmWorktreesEnrichmentResponse>({
                request: { cwd: repositoryRoot }, workingDirectory: repositoryRoot, registry,
                onNonRepository: () => ({ success: false, worktrees: [] }),
                runWithBackend: async ({ context, selection }) => {
                    const facts: NonNullable<StorageWorktree['facts']>[] = [];
                    const requested = [...new Set([...registered.map(worktree => worktree.path), ...candidates])];
                    for (let offset = 0; offset < requested.length; offset += SCM_WORKTREES_ENRICHMENT_MAX_PATHS) {
                        const response = await selection.backend.worktreesEnrichment?.({ context, request: {
                            cwd: repositoryRoot, worktreePaths: requested.slice(offset, offset + SCM_WORKTREES_ENRICHMENT_MAX_PATHS),
                        } });
                        if (response?.success && response.worktrees) facts.push(...response.worktrees);
                    }
                    return { success: true, worktrees: facts };
                },
            });
            const factsByPath = new Map((enriched.worktrees ?? []).map(facts => [facts.path, facts] as const));
            for (const facts of factsByPath.values()) {
                if (facts.retention?.kind !== 'orphan') continue;
                worktrees.set(facts.path, { path: facts.path, repositoryRoot, facts, pullRequestState: null,
                    fingerprint: facts.retention.fingerprint, retentionKind: 'orphan',
                    retentionSupported: result.snapshot.capabilities.worktreeRetention === true });
            }
            await Promise.all(registered.map(async worktree => {
                const [snapshot, fingerprint] = await Promise.all([
                    readSnapshot(worktree.path), readFingerprint(worktree.path),
                ]);
                const pr = snapshot.success ? snapshot.snapshot?.pullRequestStatus : undefined;
                const pullRequestState = readStorageWorktreePullRequestState(pr);
                worktrees.set(worktree.path, { path: worktree.path, repositoryRoot, isMain: worktree.isMain,
                    facts: factsByPath.get(worktree.path), pullRequestState,
                    retentionSupported: result.snapshot?.capabilities.worktreeRetention === true,
                    ...(fingerprint.kind === 'available' ? { fingerprint: fingerprint.fingerprint } : {}),
                });
            }));
            // Repository-wide loss facts include external dependents. Their contents use the
            // existing canonical change fingerprint, alongside SCM's refs/stashes/topology proof.
            const main = [...worktrees.values()].find(worktree => worktree.repositoryRoot === repositoryRoot && worktree.isMain);
            const retention = main?.facts?.retention;
            if (main && retention?.kind === 'main') {
                const dependentFingerprints = await Promise.all((retention.losses?.dependentWorktrees ?? [])
                    .map(async path => [path, await readFingerprint(path)] as const));
                const fingerprint = main.fingerprint && dependentFingerprints.every(([, value]) => value.kind === 'available')
                    ? `sha256:${createHash('sha256').update(JSON.stringify([main.fingerprint, retention.fingerprint, dependentFingerprints])).digest('hex')}` : undefined;
                worktrees.set(main.path, { ...main, fingerprint });
                if (!input.trashRoots?.some(root => isCanonicalAbsolutePathInsideRoot(root, retention.commonDirPath))) {
                    worktrees.set(retention.commonDirPath, { ...main, path: retention.commonDirPath, fingerprint,
                        retentionKind: 'common' });
                }
            }
        }
        return [...worktrees.values()];
    }, { happyHomeDir: input.happyHomeDir });
}
