import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type WorkspaceFileCachedContent = Readonly<{ bytes: Uint8Array; fileName: string; mimeType: string }>;

export type WorkspaceFileDownloadSource =
    | Readonly<{ kind: 'held'; content: WorkspaceFileCachedContent }>
    | Readonly<{ kind: 'workspace'; scope: WorkspaceScopeBase }>
    | Readonly<{ kind: 'unavailable' }>;

export function resolveWorkspaceFileDownloadSource(input: Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    asZip: boolean;
    cachedContent?: WorkspaceFileCachedContent | null;
}>): WorkspaceFileDownloadSource {
    // A held file is already complete. Creating an archive still needs the Machine.
    if (!input.asZip && input.cachedContent) return { kind: 'held', content: input.cachedContent };
    return input.workspaceScope ? { kind: 'workspace', scope: input.workspaceScope } : { kind: 'unavailable' };
}
