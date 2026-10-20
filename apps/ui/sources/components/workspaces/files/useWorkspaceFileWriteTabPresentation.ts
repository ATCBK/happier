import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { DetailsTabPresentation } from '@/components/appShell/panes/details/workspace/DetailsTabStrip';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceLiveFileWrites } from '@/sync/domains/session/changes/hooks/useWorkspaceLiveFileWrites';
import { storage } from '@/sync/domains/state/storageStore';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { t } from '@/text';

/** Compose file presence into the existing strip status; other resource presentations stay owned by their caller. */
export function useWorkspaceFileWriteTabPresentation(
    scope: WorkspaceScopeBase | null,
    fallback?: ((tab: DetailsTabState) => DetailsTabPresentation | null | undefined) | null,
): (tab: DetailsTabState) => DetailsTabPresentation | null | undefined {
    const writes = useWorkspaceLiveFileWrites(scope);
    const sessionIds = React.useMemo(() => [...new Set([...writes.values()].map(write => write.sessionId))], [writes]);
    const agentIds = storage(useShallow(state => sessionIds.map(id => {
        const session = state.sessions[id];
        return session ? readSessionPresentationAgentId(session) : null;
    })));
    const labels = React.useMemo(() => new Map(sessionIds.map((id, index) => [id,
        agentIds[index] ? resolveAgentCatalogTitle(agentIds[index]!) : t('newSession.wizardSection.agent'),
    ])), [agentIds, sessionIds]);
    return React.useCallback((tab: DetailsTabState) => {
        const previous = fallback?.(tab);
        if (tab.kind !== 'file' || !tab.resource || typeof tab.resource !== 'object' || !('path' in tab.resource)) return previous;
        const path = tab.resource.path;
        const write = typeof path === 'string' ? writes.get(path) : null;
        if (!write) return previous;
        return { ...previous, status: { tone: 'working', label: t('files.agentWritingThisFile', { agent: labels.get(write.sessionId) ?? t('newSession.wizardSection.agent') }) } };
    }, [fallback, labels, writes]);
}
