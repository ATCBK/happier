import * as React from 'react';

import { createSessionCommitDetailsTab } from '../details/sessionDetailsTabBuilders';
import type { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';

type PaneLike = Pick<ReturnType<typeof useAppPaneScope>, 'openDetailsTab'>;

export function useSessionRightPanelGitOpenDetails(pane: PaneLike, address: Readonly<{ sessionId: string; serverId?: string }>): Readonly<{
    openFileInDetails: (fullPath: string) => void;
    openFileInDetailsPinned: (fullPath: string) => void;
    openCommitInDetails: (sha: string) => void;
}> {
    const openDetailsTab = pane.openDetailsTab;
    const { open: openWorkspaceFile } = useWorkspaceFileOpener();

    const openFileInDetails = React.useCallback((fullPath: string) => {
        if (!address.serverId) return;
        void openWorkspaceFile({ kind: 'session', ...address, path: fullPath }, { view: 'changes' });
    }, [address.serverId, address.sessionId, openWorkspaceFile]);

    const openFileInDetailsPinned = React.useCallback((fullPath: string) => {
        if (!address.serverId) return;
        void openWorkspaceFile({ kind: 'session', ...address, path: fullPath }, { intent: 'pinned', view: 'changes' });
    }, [address.serverId, address.sessionId, openWorkspaceFile]);

    const openCommitInDetails = React.useCallback((sha: string) => {
        const tab = createSessionCommitDetailsTab(sha);
        if (!tab) return;
        openDetailsTab(tab);
    }, [openDetailsTab]);

    return { openFileInDetails, openFileInDetailsPinned, openCommitInDetails };
}
