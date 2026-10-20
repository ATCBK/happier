import { workspaceWriteFile as writeWorkspaceFile, type WorkspaceWriteFileResponse } from '@/sync/ops/workspaceFileSystem/fileReadWrite';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type { WorkspaceWriteFileResponse, WorkspaceWriteFileFailureKind } from '@/sync/ops/workspaceFileSystem/fileReadWrite';
export { classifyWorkspaceWriteFileFailure } from '@/sync/ops/workspaceFileSystem/fileReadWrite';

export async function workspaceWriteFile(params: Readonly<{
    scope: WorkspaceScopeBase;
    path: string;
    content: string | Uint8Array;
    expectedHash?: string | null;
    signal?: AbortSignal | null;
}>): Promise<WorkspaceWriteFileResponse> {
    return await writeWorkspaceFile(
        {
            machineId: params.scope.machineId,
            rootPath: params.scope.rootPath,
            serverId: params.scope.serverId,
        },
        params.path,
        params.content,
        params.expectedHash,
        { signal: params.signal },
    );
}
