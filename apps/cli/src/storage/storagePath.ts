import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalAbsolutePathsEqual, createCanonicalAbsolutePathComparator, isCanonicalAbsolutePathInsideRoot } from '@happier-dev/cli-common/path';
import { physicalPathWithoutFollowingLeaf, realpathWithAbsentSuffix } from '@/utils/path/physicalAncestorPath';

/** Native disk IDs carry non-UTF8 POSIX paths losslessly; display names are never filesystem authority. */
export function storagePathToFs(path: string): string | Buffer {
    if (!path.startsWith('bytes:')) return path;
    const encoded = path.slice(6);
    const bytes = Buffer.from(encoded, 'base64');
    if (process.platform === 'win32' || !encoded || bytes.toString('base64') !== encoded
        || bytes[0] !== 47 || bytes.includes(0)) {
        throw Object.assign(new Error('Invalid native byte path'), { code: 'invalid_storage_path' });
    }
    return bytes;
}
export function storagePathFromBytes(bytes: Buffer): string {
    const text = bytes.toString('utf8');
    return Buffer.from(text).equals(bytes) ? text : `bytes:${bytes.toString('base64')}`;
}
export function storageAbsolutePath(path: string): string {
    const decoded = storagePathToFs(path);
    if (typeof decoded === 'string') return resolve(decoded);
    const parts: Buffer[] = [];
    let start = 1;
    for (let index = 1; index <= decoded.length; index += 1) {
        if (index < decoded.length && decoded[index] !== 47) continue;
        const part = decoded.subarray(start, index); start = index + 1;
        if (!part.length || part.equals(Buffer.from('.'))) continue;
        if (part.equals(Buffer.from('..'))) parts.pop(); else parts.push(part);
    }
    return storagePathFromBytes(Buffer.concat([Buffer.from('/'), ...parts.flatMap((part, index) => index ? [Buffer.from('/'), part] : [part])]));
}
export function storagePathDirname(path: string): string {
    const decoded = storagePathToFs(path);
    if (typeof decoded === 'string') return dirname(decoded);
    const absolute = storagePathToFs(storageAbsolutePath(path));
    if (typeof absolute === 'string') return dirname(absolute);
    const slash = absolute.lastIndexOf(47);
    return storagePathFromBytes(absolute.subarray(0, Math.max(1, slash)));
}
/** Actual leaf, unlike the explicitly display-only basename below. */
export function storagePathLeaf(path: string): string | Buffer {
    const decoded = storagePathToFs(path);
    return typeof decoded === 'string' ? basename(decoded) : decoded.subarray(decoded.lastIndexOf(47) + 1);
}
export function storagePathBasename(path: string): string { return storagePathLeaf(path).toString(); }
export function storagePathJoin(root: string, ...parts: readonly (string | Buffer)[]): string {
    const decoded = storagePathToFs(root);
    if (typeof decoded === 'string' && parts.every(part => typeof part === 'string')) return join(decoded, ...parts as string[]);
    const bytes = Buffer.concat([typeof decoded === 'string' ? Buffer.from(decoded) : decoded,
        ...parts.flatMap(part => [Buffer.from('/'), typeof part === 'string' ? Buffer.from(part) : part])]);
    return storageAbsolutePath(storagePathFromBytes(bytes));
}
export function storagePathsEqual(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
    if (!left.startsWith('bytes:') && !right.startsWith('bytes:')) return canonicalAbsolutePathsEqual(left, right);
    const bytes = (path: string) => { const value = storagePathToFs(storageAbsolutePath(path)); return typeof value === 'string' ? Buffer.from(value) : value; };
    return bytes(left).equals(bytes(right));
}
export function storagePathContains(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
    if (!parent.startsWith('bytes:') && !child.startsWith('bytes:')) return storagePathsEqual(parent, child, platform)
        || isCanonicalAbsolutePathInsideRoot(parent, child, { platform });
    const bytes = (path: string) => { const value = storagePathToFs(storageAbsolutePath(path)); return typeof value === 'string' ? Buffer.from(value) : value; };
    const root = bytes(parent); const path = bytes(child);
    return root.equals(path) || path.subarray(0, root.length).equals(root) && (root.length === 1 || path[root.length] === 47);
}
/** Per-read lexical reuse; native byte paths keep their existing lossless comparator. */
export function createStoragePathComparator(platform: NodeJS.Platform = process.platform) {
    const identity = createCanonicalAbsolutePathComparator();
    const containment = createCanonicalAbsolutePathComparator({ platform });
    return {
        equal(left: string, right: string): boolean {
            return left.startsWith('bytes:') || right.startsWith('bytes:')
                ? storagePathsEqual(left, right, platform) : identity.equal(left, right);
        },
        contains(parent: string, child: string): boolean {
            return parent.startsWith('bytes:') || child.startsWith('bytes:')
                ? storagePathContains(parent, child, platform) : identity.equal(parent, child) || containment.contains(parent, child);
        },
    };
}
export type StoragePathComparator = ReturnType<typeof createStoragePathComparator>;
export async function realStoragePathWithAbsentSuffix(path: string): Promise<string> {
    const decoded = storagePathToFs(path);
    if (typeof decoded === 'string') return realpathWithAbsentSuffix(decoded);
    try { return storagePathFromBytes(await realpath(decoded, { encoding: 'buffer' })); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = storagePathDirname(path);
        if (storagePathsEqual(parent, path)) throw error;
        return storagePathJoin(await realStoragePathWithAbsentSuffix(parent), storagePathLeaf(path));
    }
}
export async function physicalStoragePathWithoutFollowingLeaf(path: string): Promise<string> {
    if (!path.startsWith('bytes:')) return physicalPathWithoutFollowingLeaf(path);
    const parent = storagePathDirname(path);
    return storagePathsEqual(parent, path) ? realStoragePathWithAbsentSuffix(path)
        : storagePathJoin(await realStoragePathWithAbsentSuffix(parent), storagePathLeaf(path));
}
