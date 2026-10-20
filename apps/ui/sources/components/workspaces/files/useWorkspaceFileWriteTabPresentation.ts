import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { DetailsTabPresentation } from '@/components/appShell/panes/details/workspace/DetailsTabStrip';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceLiveFileWrites } from '@/sync/domains/session/changes/hooks/useWorkspaceLiveFileWrites';
import type { LiveFileWrite } from '@/sync/domains/session/changes/derivation/deriveLiveFileWrites';
import { storage } from '@/sync/domains/state/storageStore';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { t } from '@/text';

/**
 * The Agent writing each live file, named from its Session ("Claude is writing this file"): one owner for
 * the tab strip's status and the Files tree's row spinner.
 */
export function useLiveFileWriteAgentLabels(writes: ReadonlyMap<string, LiveFileWrite>): Readonly<{ get(sessionId: string): string }> {
    const sessionIds = React.useMemo(() => [...new Set([...writes.values()].map(write => write.sessionId))], [writes]);
    const agentIds = storage(useShallow(state => sessionIds.map(id => {
        const session = state.sessions[id];
        return session ? readSessionPresentationAgentId(session) : null;
    })));
    return React.useMemo(() => {
        const byId = new Map(sessionIds.map((id, index) => [id, agentIds[index] ? resolveAgentCatalogTitle(agentIds[index]!) : null]));
        return { get: (sessionId: string) => byId.get(sessionId) ?? t('newSession.wizardSection.agent') };
    }, [agentIds, sessionIds]);
}

/** Compose file presence into the existing strip status; other resource presentations stay owned by their caller. */
export function useWorkspaceFileWriteTabPresentation(
    scope: WorkspaceScopeBase | null,
    fallback?: ((tab: DetailsTabState) => DetailsTabPresentation | null | undefined) | null,
): (tab: DetailsTabState) => DetailsTabPresentation | null | undefined {
    const writes = useWorkspaceLiveFileWrites(scope);
    const labels = useLiveFileWriteAgentLabels(writes);
    return React.useCallback((tab: DetailsTabState) => {
        const previous = fallback?.(tab);
        if (tab.kind !== 'file' || !tab.resource || typeof tab.resource !== 'object' || !('path' in tab.resource)) return previous;
        const path = tab.resource.path;
        const write = typeof path === 'string' ? writes.get(path) : null;
        if (!write) return previous;
        return { ...previous, status: { tone: 'working', label: t('files.agentWritingThisFile', { agent: labels.get(write.sessionId) }) } };
    }, [fallback, labels, writes]);
}
