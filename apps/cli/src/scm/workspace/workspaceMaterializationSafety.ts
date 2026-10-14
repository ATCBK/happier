import { isAbsolute, join, relative, resolve, dirname, sep } from 'node:path';

import { resolveWorkspaceRelativePath } from './workspaceExportPackaging/resolveWorkspaceRelativePath';
import { resolveNativeFilesystemPathForAuthorization } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';

export function resolveContainedWorkspaceMaterializationPath(params: Readonly<{
    workspaceRoot: string;
    candidatePath: string;
    errorMessage: string;
    pathRepresentation?: 'native_literal';
}>): string {
    if (params.pathRepresentation === 'native_literal') {
        const root = resolve(params.workspaceRoot);
        const nativePath = resolve(root, params.candidatePath);
        const nativeRelative = relative(root, nativePath);
        if (isAbsolute(nativeRelative) || nativeRelative === '..' || nativeRelative.startsWith(`..${sep}`)) {
            throw new Error(params.errorMessage);
        }
        return nativePath;
    }
    const resolvedPath = resolveWorkspaceRelativePath({
        workspaceRoot: params.workspaceRoot,
        candidatePath: params.candidatePath,
    });
    if (!resolvedPath.ok) {
        throw new Error(params.errorMessage);
    }
    return join(resolve(params.workspaceRoot), resolvedPath.relativePath);
}

export function assertWorkspaceMaterializationSymlinkTarget(params: Readonly<{
    workspaceRoot: string;
    linkPath: string;
    target: string;
    pathRepresentation?: 'native_literal';
    installed?: true;
}>): void {
    if (!params.target || isAbsolute(params.target)) {
        throw new Error(`Workspace transfer symlink target escapes target: ${params.target}`);
    }
    resolveContainedWorkspaceMaterializationPath({
        workspaceRoot: params.workspaceRoot,
        candidatePath: resolve(dirname(params.linkPath), params.target),
        errorMessage: `Workspace transfer symlink target escapes target: ${params.target}`,
        ...(params.pathRepresentation ? { pathRepresentation: params.pathRepresentation } : {}),
    });
    if (params.installed) {
        // Validate after all captured links are installed. Concatenation retains
        // native target-parent spelling until the OS follows symlinks and '..'.
        const root = resolveNativeFilesystemPathForAuthorization(params.workspaceRoot);
        const target = `${dirname(params.linkPath)}${sep}${params.target}`;
        resolveContainedWorkspaceMaterializationPath({ workspaceRoot: root,
            candidatePath: resolveNativeFilesystemPathForAuthorization(target),
            errorMessage: 'Workspace transfer symlink target escapes its native root', pathRepresentation: 'native_literal' });
    }
}
