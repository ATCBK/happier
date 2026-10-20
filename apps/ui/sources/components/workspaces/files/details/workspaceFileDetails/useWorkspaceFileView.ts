import * as React from 'react';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { buildWorkspaceFileViewPatch, readWorkspaceFileView, type WorkspaceFileView } from './workspaceFileView';

/** Memory belongs to the existing file tab; this hook only binds its reader and patch writer. */
export function useWorkspaceFileView(pane: AppPaneScopeApi, tabKey: string) {
    const tabState = pane.scopeState?.details.tabState[tabKey];
    const current = React.useRef({ tabKey, tabState, patch: pane.patchDetailsTabState });
    current.current = { tabKey, tabState, patch: pane.patchDetailsTabState };
    const patchView = React.useCallback((patch: Partial<WorkspaceFileView>) => {
        const target = current.current;
        const next = buildWorkspaceFileViewPatch(target.tabState, patch);
        // Consecutive controls in one event merge before React publishes the next pane snapshot.
        target.tabState = next;
        target.patch(target.tabKey, next);
    }, []);
    return { view: React.useMemo(() => readWorkspaceFileView(tabState), [tabState]), patchView };
}
