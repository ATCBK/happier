import { describe, expect, it } from 'vitest';
import type { LazyDirectoryTreeEntry } from './lazyDirectoryTreeTypes';
import { collectLazyDirectoryTreeMutationPaths, replaceLazyDirectoryTreeDirectory, resolveLazyDirectoryTreeMutationDirectories } from './reconcileLazyDirectoryTree';

const entry = (path: string, type: 'file' | 'directory'): LazyDirectoryTreeEntry => ({ path, name: path.split('/').at(-1)!, type });

describe('lazy tree reconciliation decisions', () => {
    it('holds settled paths during an edit and replays one coalesced batch when it ends', () => {
        const held = collectLazyDirectoryTreeMutationPaths({ paths: ['a.ts', 'a.ts'], pendingPaths: new Set(), paused: true });
        expect(held.paths).toEqual([]);
        const second = collectLazyDirectoryTreeMutationPaths({ paths: ['b.ts'], pendingPaths: held.pendingPaths, paused: true });
        const replay = collectLazyDirectoryTreeMutationPaths({ paths: [], pendingPaths: second.pendingPaths, paused: false });
        expect(replay.paths).toEqual(['a.ts', 'b.ts']);
        expect(replay.pendingPaths.size).toBe(0);
    });
    const directoryEntriesByPath = new Map([
        ['', [entry('src', 'directory'), entry('src-other', 'directory')]],
        ['src', [entry('src/nested', 'directory'), entry('src/old.ts', 'file')]],
        ['src/nested', [entry('src/nested/old.ts', 'file')]],
    ]);

    it('selects one nearest loaded ancestor per settled path and never a sibling prefix', () => {
        expect(resolveLazyDirectoryTreeMutationDirectories({ paths: ['src/new.ts', 'src/newer.ts', 'src-other/new.ts'],
            directoryEntriesByPath, expandedDirectories: new Set(['src']), loadingDirectories: new Set(), rootDirectoryPath: '',
        })).toEqual({ reload: ['src', ''], stale: ['src', ''] });
    });

    it('marks a collapsed cached branch stale, including an expanded descendant hidden by its parent', () => {
        expect(resolveLazyDirectoryTreeMutationDirectories({ paths: ['src/nested/new.ts'], directoryEntriesByPath,
            expandedDirectories: new Set(['src/nested']), loadingDirectories: new Set(), rootDirectoryPath: '',
        })).toEqual({ reload: [], stale: ['src/nested'] });
    });

    it('re-lists the parent when the settled path names a cached directory itself', () => {
        expect(resolveLazyDirectoryTreeMutationDirectories({ paths: ['src/nested'], directoryEntriesByPath,
            expandedDirectories: new Set(['src', 'src/nested']), loadingDirectories: new Set(), rootDirectoryPath: '',
        })).toEqual({ reload: ['src'], stale: ['src'] });
    });

    it('queues a trailing root refresh during the first load and confines folder-page mutations', () => {
        expect(resolveLazyDirectoryTreeMutationDirectories({ paths: ['created.ts'], directoryEntriesByPath: new Map(),
            expandedDirectories: new Set(), loadingDirectories: new Set(['']), rootDirectoryPath: '',
        })).toEqual({ reload: [''], stale: [''] });
        expect(resolveLazyDirectoryTreeMutationDirectories({ paths: ['outside/new.ts'], directoryEntriesByPath: new Map([['src', []]]),
            expandedDirectories: new Set(), loadingDirectories: new Set(), rootDirectoryPath: 'src',
        })).toEqual({ reload: [], stale: [] });
    });

    it('prunes removed directory descendants and identifies new rows without pruning a sibling prefix', () => {
        const map = new Map(directoryEntriesByPath);
        map.set('src-other', [entry('src-other/keep.ts', 'file')]);
        const result = replaceLazyDirectoryTreeDirectory({ directoryEntriesByPath: map, directoryPath: '',
            entries: [entry('src-other', 'directory'), entry('new.ts', 'file')] });
        expect([...result.directoryEntriesByPath.keys()]).toEqual(['', 'src-other']);
        expect(result.prunedDirectoryRoots).toEqual(['src']);
        expect([...result.arrivedPaths]).toEqual(['new.ts']);
        expect(map.has('src/nested')).toBe(true);
    });

    it('does not flag the first loaded directory as an arrival batch', () => {
        expect(replaceLazyDirectoryTreeDirectory({ directoryEntriesByPath: new Map(), directoryPath: '',
            entries: [entry('initial.ts', 'file')] }).arrivedPaths.size).toBe(0);
    });
});
