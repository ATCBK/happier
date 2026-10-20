import type { LazyDirectoryTreeEntry } from './lazyDirectoryTreeTypes';

export function collectLazyDirectoryTreeMutationPaths(input: Readonly<{
    paths: readonly string[];
    pendingPaths: ReadonlySet<string>;
    paused: boolean;
}>): Readonly<{ paths: readonly string[]; pendingPaths: Set<string> }> {
    const paths = new Set([...input.pendingPaths, ...input.paths]);
    return input.paused ? { paths: [], pendingPaths: paths } : { paths: [...paths], pendingPaths: new Set() };
}

export function resolveLazyDirectoryTreeMutationDirectories(input: Readonly<{
    paths: readonly string[];
    directoryEntriesByPath: ReadonlyMap<string, readonly LazyDirectoryTreeEntry[]>;
    expandedDirectories: ReadonlySet<string>;
    loadingDirectories: ReadonlySet<string>;
    rootDirectoryPath: string;
}>): Readonly<{ reload: readonly string[]; stale: readonly string[] }> {
    const directories = new Set<string>();
    const root = input.rootDirectoryPath;
    for (const path of input.paths) {
        if (root && path !== root && !path.startsWith(`${root}/`)) continue;
        let nearest: string | null = input.directoryEntriesByPath.has(root) || input.loadingDirectories.has(root) ? root : null;
        for (const loadedPath of input.directoryEntriesByPath.keys()) {
            if (loadedPath !== root && path === loadedPath) continue;
            if (loadedPath === '' || path === loadedPath || path.startsWith(`${loadedPath}/`)) {
                if (nearest === null || loadedPath.length > nearest.length) nearest = loadedPath;
            }
        }
        if (nearest !== null) directories.add(nearest);
    }
    const reload = [...directories].filter(directory => {
        if (directory === root) return true;
        if (!input.expandedDirectories.has(directory)) return false;
        return ![...input.directoryEntriesByPath.keys()].some(ancestor => ancestor !== root
            && directory.startsWith(`${ancestor}/`) && !input.expandedDirectories.has(ancestor));
    });
    return { reload, stale: [...directories] };
}

export function replaceLazyDirectoryTreeDirectory(input: Readonly<{
    directoryEntriesByPath: ReadonlyMap<string, LazyDirectoryTreeEntry[]>;
    directoryPath: string;
    entries: LazyDirectoryTreeEntry[];
}>): Readonly<{
    directoryEntriesByPath: Map<string, LazyDirectoryTreeEntry[]>;
    prunedDirectoryRoots: readonly string[];
    arrivedPaths: ReadonlySet<string>;
}> {
    const next = new Map(input.directoryEntriesByPath);
    const previousEntries = next.get(input.directoryPath);
    const nextDirectories = new Set(input.entries.filter(entry => entry.type === 'directory').map(entry => entry.path));
    const prunedDirectoryRoots = (previousEntries ?? []).filter(entry => entry.type === 'directory' && !nextDirectories.has(entry.path)).map(entry => entry.path);
    for (const path of next.keys()) {
        if (prunedDirectoryRoots.some(root => path === root || path.startsWith(`${root}/`))) next.delete(path);
    }
    next.set(input.directoryPath, input.entries);
    const previousPaths = new Set(previousEntries?.map(entry => entry.path));
    const arrivedPaths = new Set(previousEntries ? input.entries.filter(entry => !previousPaths.has(entry.path)).map(entry => entry.path) : []);
    return { directoryEntriesByPath: next, prunedDirectoryRoots, arrivedPaths };
}
