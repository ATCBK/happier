import type { ScmBackendRegistry } from '@/scm/registry';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN, type ScmWorktreeRemoveResponse } from '@happier-dev/protocol/scm';

type Target = Readonly<{ repositoryRoot: string; worktreePath: string; beforeEffect?: () => Promise<void> }>;
type MoveTarget = Target & Readonly<{ targetPath: string; entryId: string }>;

/** Storage delegates to the same selected contribution as interactive source-control operations. */
export function createStorageWorktreeOperations(deps: Readonly<{ happyHomeDir: string; registry?: ScmBackendRegistry }>) {
    async function run(target: Target, operation: 'retire' | 'reinstate' | 'remove', move?: MoveTarget): Promise<void> {
        let guardFailed = false;
        let guardError: unknown;
        const beforeFilesystemMutation = target.beforeEffect ? async () => {
            try { await target.beforeEffect?.(); }
            catch (error) { guardFailed = true; guardError = error; throw error; }
        } : undefined;
        const result = await runWithScmBackendRegistryLease(deps.registry, registry => runScmRoute<
            { cwd: string }, ScmWorktreeRemoveResponse
        >({
            request: { cwd: target.repositoryRoot }, workingDirectory: target.repositoryRoot, registry,
            onNonRepository: () => ({ success: false, errorCode: 'NOT_REPOSITORY' }),
            runWithBackend: async ({ context, selection }) => {
                if (operation === 'remove') {
                    if (!selection.backend.worktreeRemove) return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
                    return selection.backend.worktreeRemove({ context: { ...context, beforeFilesystemMutation }, request: { cwd: target.repositoryRoot,
                        worktreePath: target.worktreePath, confirmed: true, authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } });
                }
                const handler = operation === 'retire' ? selection.backend.worktreeRetire : selection.backend.worktreeReinstate;
                if (!handler || !move) return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
                return handler({ context: { ...context, beforeFilesystemMutation }, request: { cwd: target.repositoryRoot, worktreePath: target.worktreePath,
                    targetPath: move.targetPath, entryId: move.entryId } });
            },
        }), { happyHomeDir: deps.happyHomeDir });
        if (guardFailed) throw guardError;
        if (!result.success) throw Object.assign(new Error(result.error ?? 'Worktree operation failed'), { errorCode: result.errorCode });
    }
    return {
        retire: (target: MoveTarget) => run(target, 'retire', target),
        reinstate: (target: MoveTarget) => run(target, 'reinstate', target),
        remove: (target: Target) => run(target, 'remove'),
    };
}
