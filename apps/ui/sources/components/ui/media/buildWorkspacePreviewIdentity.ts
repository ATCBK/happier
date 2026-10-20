import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

/** Page, review and stage consumers share both the workspace and file-version identity. */
export function buildWorkspacePreviewIdentity(
    scope: WorkspaceScopeBase,
    filePath: string,
    sizeBytes?: number | null,
    signature?: string | null,
): Readonly<{ cacheScopeId: string; cacheKey: string }> {
    return {
        cacheScopeId: `${scope.serverId}:${scope.machineId}:${scope.rootPath}`,
        cacheKey: JSON.stringify([filePath, sizeBytes ?? null, signature ?? null]),
    };
}

