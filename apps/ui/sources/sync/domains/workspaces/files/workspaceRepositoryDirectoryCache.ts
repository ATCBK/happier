import type { RepositoryDirectoryEntry } from '@/sync/domains/input/repositoryDirectoryEntries';

type DirectoryCacheEntry = Readonly<{ entries: RepositoryDirectoryEntry[]; gitIgnoreAvailable?: boolean }>;
const directoryCache = new Map<string, DirectoryCacheEntry>();

function cacheKey(workspaceCacheKey: string, directoryPath: string): string {
    return `${workspaceCacheKey}:${directoryPath}`;
}

export function getCachedWorkspaceRepositoryDirectoryEntries(input: Readonly<{
    workspaceCacheKey: string;
    directoryPath: string;
}>): RepositoryDirectoryEntry[] | null {
    return directoryCache.get(cacheKey(input.workspaceCacheKey, input.directoryPath))?.entries.slice() ?? null;
}

export function getCachedWorkspaceRepositoryGitIgnoreAvailable(input: Readonly<{
    workspaceCacheKey: string;
    directoryPath: string;
}>): boolean | undefined {
    return directoryCache.get(cacheKey(input.workspaceCacheKey, input.directoryPath))?.gitIgnoreAvailable;
}

export function setCachedWorkspaceRepositoryDirectoryEntries(input: Readonly<{
    workspaceCacheKey: string;
    directoryPath: string;
    entries: RepositoryDirectoryEntry[];
    gitIgnoreAvailable?: boolean;
}>): void {
    const key = cacheKey(input.workspaceCacheKey, input.directoryPath);
    const previous = directoryCache.get(key);
    const nextDirectories = new Set(input.entries.filter(entry => entry.type === 'directory').map(entry => entry.name));
    for (const removed of previous?.entries ?? []) {
        if (removed.type !== 'directory' || nextDirectories.has(removed.name)) continue;
        const path = input.directoryPath ? `${input.directoryPath}/${removed.name}` : removed.name;
        const removedKey = cacheKey(input.workspaceCacheKey, path);
        for (const cachedKey of directoryCache.keys()) {
            if (cachedKey === removedKey || cachedKey.startsWith(`${removedKey}/`)) directoryCache.delete(cachedKey);
        }
    }
    directoryCache.set(key, {
        entries: input.entries.slice(), gitIgnoreAvailable: input.gitIgnoreAvailable,
    });
}

export function clearWorkspaceRepositoryDirectoryCacheEntries(input: Readonly<{
    workspaceCacheKey: string;
    directoryPath?: string | null;
}>): void {
    if (typeof input.directoryPath === 'string') {
        directoryCache.delete(cacheKey(input.workspaceCacheKey, input.directoryPath));
        return;
    }
    const prefix = `${input.workspaceCacheKey}:`;
    for (const key of directoryCache.keys()) if (key.startsWith(prefix)) directoryCache.delete(key);
}
