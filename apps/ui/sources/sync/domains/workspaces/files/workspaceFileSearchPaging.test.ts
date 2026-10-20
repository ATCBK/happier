import { describe, expect, it } from 'vitest';
import { resolveWorkspaceFileQueryLimit, resolveWorkspaceFileSearchPageAvailability } from './workspaceFileSearchPaging';
import type { WorkspaceFileSearchPage } from './workspaceFileSearch';

describe('workspace filename paging', () => {
    const scope = { serverId: 'home', machineId: 'machine', rootPath: '/repo' };
    it('expands matching queries by pages and resets the visible window across query and workspace identities', () => {
        expect(resolveWorkspaceFileQueryLimit({ scope, query: 'needle', pageSize: 20, limit: 200, paging: null })).toBe(20);
        const paging = { scope, query: 'needle', pages: 3 };
        expect(resolveWorkspaceFileQueryLimit({ scope, query: 'needle', pageSize: 20, paging })).toBe(60);
        expect(resolveWorkspaceFileQueryLimit({ scope, query: 'new', pageSize: 20, paging })).toBe(20);
        expect(resolveWorkspaceFileQueryLimit({ scope: { ...scope }, query: 'needle', pageSize: 20, paging })).toBe(20);
        expect(resolveWorkspaceFileQueryLimit({ scope, query: 'needle', limit: 12, paging })).toBe(12);
    });
    it('keeps incomplete-source coverage without an endless Show more on an under-full page', () => {
        const items = Array.from({ length: 5 }, (_, index) => ({ fileName: `${index}.ts`, filePath: '', fullPath: `${index}.ts`, fileType: 'file' as const }));
        const partial: WorkspaceFileSearchPage = { items, corpusTruncated: true, hasMore: true };
        expect(resolveWorkspaceFileSearchPageAvailability(partial, 20)).toEqual({ hasMore: true, canLoadMore: false });
        expect(resolveWorkspaceFileSearchPageAvailability(partial, 5)).toEqual({ hasMore: true, canLoadMore: true });
        expect(resolveWorkspaceFileSearchPageAvailability({ ...partial, corpusTruncated: false, hasMore: false }, 5))
            .toEqual({ hasMore: false, canLoadMore: false });
    });
});
