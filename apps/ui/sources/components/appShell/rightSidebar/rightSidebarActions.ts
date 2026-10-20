import * as React from 'react';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

export type RightSidebarActions = Readonly<{
    tabs: readonly string[];
    activeTab?: string;
    selectTab(tab: string): void;
}>;

/** The mounted rail publishes its existing catalog and chooser to its enclosing pane host. */
export const RightSidebarActionsContext = React.createContext<React.MutableRefObject<RightSidebarActions | null> | null>(null);

export function usePublishRightSidebarActions(actions: RightSidebarActions): void {
    const owner = React.useContext(RightSidebarActionsContext);
    const latest = React.useRef(actions);
    latest.current = actions;
    React.useLayoutEffect(() => {
        if (!owner) return;
        const publication: RightSidebarActions = {
            get tabs() { return latest.current.tabs; },
            get activeTab() { return latest.current.activeTab; },
            selectTab: tab => latest.current.selectTab(tab),
        };
        owner.current = publication;
        return () => { if (owner.current === publication) owner.current = null; };
    }, [owner]);
}

export function toggleRightSidebarTab(
    pane: Pick<AppPaneScopeApi, 'scopeState' | 'closeRight' | 'closeDetails'>,
    tabId: string,
    activeTabId: string | null,
    onSelectTab: (tabId: string) => void,
    rightPaneHiddenByDetails = false,
): void {
    if (rightPaneHiddenByDetails) {
        pane.closeDetails();
        onSelectTab(tabId);
    } else if (pane.scopeState?.right.isOpen && activeTabId === tabId) {
        pane.closeRight();
    } else {
        onSelectTab(tabId);
    }
}
