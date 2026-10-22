import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

/** Page, review and stage share versioned bytes; an unversioned working file must be read afresh. */
export function buildWorkspacePreviewIdentity(
    scope: WorkspaceScopeBase,
    filePath: string,
    sizeBytes?: number | null,
    signature?: string | null,
): Readonly<{ cacheScopeId: string; cacheKey: string | null }> {
    return {
        cacheScopeId: buildWorkspaceCacheKey(scope),
        // Path and length cannot distinguish an edit from the bytes Markdown previously loaded.
        cacheKey: signature?.trim() ? JSON.stringify([filePath, sizeBytes ?? null, signature]) : null,
    };
}

