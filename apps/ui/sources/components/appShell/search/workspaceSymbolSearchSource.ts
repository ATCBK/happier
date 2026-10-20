import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { loadDocumentOutlineBaseline } from '@/sync/domains/workspaces/languageIntelligence/loadDocumentOutlineBaseline';
import { buildUniversalSearchScopeKey, type UniversalSearchResult, type UniversalSearchTarget } from './universalSearchResult';
import { buildUniversalSearchSymbolResults } from './workspaceSymbolSearchResults';

export type WorkspaceSymbolSearchInput = Readonly<{
    target: Extract<UniversalSearchTarget, { kind: 'workspaceFile' }>;
    resolverKey: string;
    getText(): string;
    flushPendingChange(): void | Promise<void>;
    isCurrent(): boolean;
    accountLifetime: ServerAccountScopeLifetime;
    language: string;
    isDark: boolean;
    colors?: Record<string, unknown> | null;
    unavailableHint: string;
}>;

export type WorkspaceSymbolSearchSource = Readonly<{
    status: 'ready';
    resolverKey: string;
    resolve(query: string, signal: AbortSignal): Promise<Readonly<{ results: readonly UniversalSearchResult[]; emptyHint?: string }>>;
}>;

export function createWorkspaceSymbolSearchSource(input: WorkspaceSymbolSearchInput): WorkspaceSymbolSearchSource {
    return {
        status: 'ready',
        resolverKey: buildUniversalSearchScopeKey([
            input.target.accountId, input.target.scope.serverId, input.target.scope.machineId,
            input.target.scope.rootPath, input.target.path, input.resolverKey,
        ]),
        resolve: async (query, signal) => {
            const assertCurrent = () => {
                if (signal.aborted || !input.isCurrent() || !input.accountLifetime.isCurrent()
                    || input.accountLifetime.scope.accountId !== input.target.accountId
                    || input.accountLifetime.scope.serverId !== input.target.scope.serverId
                    || (input.target.serverId !== null && input.target.serverId !== input.target.scope.serverId)) {
                    const error = new Error('Active file symbol source retired');
                    error.name = 'AbortError';
                    throw error;
                }
            };
            assertCurrent();
            await input.flushPendingChange();
            assertCurrent();
            const text = input.getText();
            const outline = await loadDocumentOutlineBaseline({
                lines: text.split(/\r\n|\r|\n/u), language: input.language, isDark: input.isDark, colors: input.colors,
            });
            assertCurrent();
            if (input.getText() !== text) {
                const error = new Error('Active file changed during symbol search');
                error.name = 'AbortError';
                throw error;
            }
            if (outline.status === 'unavailable') return { results: [], emptyHint: input.unavailableHint };
            const needle = query.trim().toLocaleLowerCase();
            return {
                results: buildUniversalSearchSymbolResults(
                    outline.symbols.filter(symbol => symbol.name.toLocaleLowerCase().includes(needle)), input.target,
                ),
            };
        },
    };
}
