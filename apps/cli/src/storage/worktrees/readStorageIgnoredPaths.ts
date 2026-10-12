import type { ScmBackendRegistry } from '@/scm/registry';
import type { BackendRuntimeHandlers } from '@happier-dev/plugin-sdk/scm/backend';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';

type Response = Awaited<ReturnType<NonNullable<NonNullable<BackendRuntimeHandlers['read']>['ignoredPaths']>>>;
export async function readStorageIgnoredPaths(input: Readonly<{ repositoryRoot: string; happyHomeDir?: string; registry?: ScmBackendRegistry }>): Promise<readonly string[] | null> {
    const result = await runWithScmBackendRegistryLease(input.registry, registry => runScmRoute<{ cwd: string }, Response>({
        request: { cwd: input.repositoryRoot }, workingDirectory: input.repositoryRoot, registry,
        onNonRepository: () => ({ success: false }),
        runWithBackend: async ({ context, selection }) => selection.backend.ignoredPaths
            ? selection.backend.ignoredPaths({ context, request: { cwd: input.repositoryRoot }, signal: context.signal ?? new AbortController().signal })
            : { success: false, errorCode: 'FEATURE_UNSUPPORTED' },
    }), { happyHomeDir: input.happyHomeDir });
    return result.success && result.paths ? result.paths : null;
}
