import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { WorkspaceFileSearchPage } from './workspaceFileSearch';

export type WorkspaceFileQueryPaging = Readonly<{
    scope: WorkspaceScopeBase | null;
    query: string;
    pages: number;
}>;

export function resolveWorkspaceFileQueryLimit(input: Readonly<{
    scope: WorkspaceScopeBase | null;
    query: string;
    pageSize?: number;
    limit?: number;
    paging: WorkspaceFileQueryPaging | null;
}>): number | undefined {
    if (input.pageSize === undefined) return input.limit;
    const pages = input.paging?.scope === input.scope && input.paging.query === input.query ? input.paging.pages : 1;
    return input.pageSize * pages;
}

/** Source incompleteness stays visible even when a further UI page cannot reveal more rows. */
export function resolveWorkspaceFileSearchPageAvailability(page: WorkspaceFileSearchPage | null, requestedLimit: number | undefined): Readonly<{
    hasMore: boolean;
    canLoadMore: boolean;
}> {
    return { hasMore: page?.hasMore ?? false,
        canLoadMore: page?.hasMore === true && requestedLimit !== undefined && page.items.length >= requestedLimit };
}
