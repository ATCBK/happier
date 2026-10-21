import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

function joinUploadPath(parentDir: string, relativePath: string): string {
    const parent = String(parentDir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    const relative = String(relativePath ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!parent) return relative.replace(/\/+/g, '/');
    if (!relative) return parent;
    return `${parent}/${relative}`.replace(/\/+/g, '/');
}

/** Validate before joining so an absolute source cannot become relative. */
export function resolveUploadRelativePath(parentDir: string, relativePath: string): string | null {
    const relative = String(relativePath ?? '').trim().replace(/\\/g, '/');
    if (!isSafeWorkspaceRelativePath(relative)) return null;
    const path = joinUploadPath(parentDir, relative);
    return isSafeWorkspaceRelativePath(path) ? path : null;
}
