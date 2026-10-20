import { posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { FilesystemAccessPolicy } from '../rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPathWithinRoot } from '../rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';

export type WorkspacePathContext = Readonly<{ rootPath: string; platform?: NodeJS.Platform; accessPolicy?: FilesystemAccessPolicy }>;
export class LspWorkspacePathError extends Error {
    constructor(readonly code: 'invalid_path' | 'unsupported_root', message: string) { super(message); this.name = 'LspWorkspacePathError'; }
}

function workspaceRoot(context: WorkspacePathContext): string {
    const platform = context.platform ?? process.platform;
    if (platform === 'win32' && /^[\\/]{2}/u.test(context.rootPath)) {
        throw new LspWorkspacePathError('unsupported_root', 'UNC workspace roots are not supported');
    }
    const api = platform === 'win32' ? win32 : posix;
    if (!api.isAbsolute(context.rootPath) || (platform === 'win32' && !/^[A-Za-z]:[\\/]/u.test(context.rootPath))) {
        throw new LspWorkspacePathError('invalid_path', 'The workspace root must be an absolute native path');
    }
    const authorized = authorizeFilesystemPathWithinRoot({
        rootPath: context.rootPath, targetPath: '.', defaultDirectory: context.rootPath,
        accessPolicy: context.accessPolicy ?? { kind: 'restrictedRoots', roots: [context.rootPath] }, platform,
    });
    if (!authorized.valid) throw new LspWorkspacePathError('invalid_path', authorized.error);
    return authorized.rootPath;
}

export function resolveWorkspacePath(context: WorkspacePathContext, path: string): string {
    const platform = context.platform ?? process.platform;
    const api = platform === 'win32' ? win32 : posix;
    const rootPath = workspaceRoot(context);
    if (!path || api.isAbsolute(path) || /^[A-Za-z]:/u.test(path)) {
        throw new LspWorkspacePathError('invalid_path', 'A workspace-relative path is required');
    }
    const authorized = authorizeFilesystemPathWithinRoot({
        rootPath, targetPath: path, defaultDirectory: rootPath,
        accessPolicy: context.accessPolicy ?? { kind: 'restrictedRoots', roots: [rootPath] }, platform,
    });
    if (!authorized.valid) throw new LspWorkspacePathError('invalid_path', authorized.error);
    return authorized.resolvedPath;
}

export function workspacePathToUri(context: WorkspacePathContext, path: string): string {
    return pathToFileURL(resolveWorkspacePath(context, path), { windows: (context.platform ?? process.platform) === 'win32' }).href;
}

/** Map server locations for presentation. Outside locations never grant read authority. */
export function workspaceUriToPath(context: WorkspacePathContext, uri: string): Readonly<{ path: string; outsideWorkspace?: true }> {
    const platform = context.platform ?? process.platform;
    const api = platform === 'win32' ? win32 : posix;
    const rootPath = workspaceRoot(context);
    let absolutePath: string;
    try {
        const url = new URL(uri);
        if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search || url.hash) {
            throw new LspWorkspacePathError('invalid_path', 'A local file URI is required');
        }
        absolutePath = fileURLToPath(url, { windows: platform === 'win32' });
        if (platform !== 'win32' && /^\/[A-Za-z]:/u.test(absolutePath)) {
            throw new LspWorkspacePathError('invalid_path', 'The file URI does not match the Machine OS');
        }
    } catch (error) {
        if (error instanceof LspWorkspacePathError) throw error;
        throw new LspWorkspacePathError('invalid_path', 'The file URI does not match the Machine OS');
    }
    if (platform === 'win32' && absolutePath[0]?.toLowerCase() === rootPath[0]?.toLowerCase()) {
        absolutePath = rootPath[0] + absolutePath.slice(1);
    }
    const relative = api.relative(rootPath, absolutePath);
    if (relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
        return { path: absolutePath, outsideWorkspace: true };
    }
    try {
        resolveWorkspacePath(context, relative || '.');
    } catch (error) {
        // A lexical child may be a symlink to a file outside the root. Report the
        // location without opening it; all reads still use resolveWorkspacePath.
        if (error instanceof LspWorkspacePathError && error.code === 'invalid_path') return { path: absolutePath, outsideWorkspace: true };
        throw error;
    }
    return { path: relative.split(api.sep).join('/') };
}
