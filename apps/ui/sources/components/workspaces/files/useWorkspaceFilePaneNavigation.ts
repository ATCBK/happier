import * as React from 'react';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';

/** File navigation changes the adjacent destination, retaining the file's tab and draft. */
export function useWorkspaceFilePaneNavigation(scopeId: string, onNavigate?: (tabId: 'files' | 'git') => void) {
    const context = React.useContext(AppPaneContext);
    const pane = useAppPaneScope(scopeId, () => null);
    const navigate = React.useCallback((tabId: 'files' | 'git', patch: Record<string, unknown>) => {
        const current = context?.getSnapshot().state.scopes[scopeId]?.right.tabState[tabId];
        pane.setRightTabState(tabId, { ...(current && typeof current === 'object' ? current : {}), ...patch });
        pane.openRight({ tabId });
        pane.setRightTab(tabId);
        onNavigate?.(tabId);
    }, [context, onNavigate, pane, scopeId]);
    const openChanges = React.useCallback(() => navigate('git', { activeSubTabId: 'commit' }), [navigate]);
    const openFiles = React.useCallback((path?: string) => navigate('files', path ? { revealRequest: { path } } : {}), [navigate]);
    return { revealInFilesTree: openFiles, openChanges, openFiles };
}
