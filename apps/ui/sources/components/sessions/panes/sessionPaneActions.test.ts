import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { describe, expect, it } from 'vitest';
import { appPaneReduce, createAppPaneState, type AppPaneAction } from '@/components/appShell/panes/model/appPaneReducer';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SESSION_DETAILS_SCM_REVIEW_TAB_KEY } from './details/sessionDetailsTabBuilders';
import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';
import { toggleSessionReview } from './sessionPaneActions';
import { toggleRightSidebarTab } from '@/components/appShell/rightSidebar/rightSidebarActions';

function selectSessionRightTab(pane: ReturnType<typeof paneHarness>, tabId: string) {
    toggleRightSidebarTab(pane, tabId, pane.scopeState?.right.activeTabId ?? null, (id) => pane.openRight({ tabId: id }));
}

function paneHarness() {
    const scopeId = 'session:rail';
    let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
    const dispatch = (action: AppPaneAction) => { state = appPaneReduce(state, action); };
    const pane: Pick<AppPaneScopeApi, 'scopeState' | 'openRight' | 'closeRight' | 'openDetailsTab' | 'closeDetails'> = {
        get scopeState() { const scope = state.scopes[scopeId]; return scope ? { ...scope, details: buildDetailsWorkspaceStateView(scope.details) } : null; },
        openRight: (options) => dispatch({ type: 'openRight', scopeId, tabId: options?.tabId }),
        closeRight: () => dispatch({ type: 'closeRight', scopeId }),
        openDetailsTab: (tab, options) => dispatch({ type: 'openDetailsTab', scopeId, tab, openAs: options?.intent === 'pinned' ? 'pinned' : 'preview' }),
        closeDetails: () => dispatch({ type: 'closeDetails', scopeId }),
    };
    return pane;
}

describe('session pane rail actions', () => {
    it('toggles the selected right pane closed and reopens or switches tabs', () => {
        const pane = paneHarness();
        selectSessionRightTab(pane, 'files');
        expect(pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
        selectSessionRightTab(pane, 'files');
        expect(pane.scopeState?.right).toMatchObject({ isOpen: false, activeTabId: 'files' });
        selectSessionRightTab(pane, 'files');
        selectSessionRightTab(pane, 'agents');
        expect(pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'agents' });
    });

    it('reveals the selected right pane when Details hides it, retaining its details tabs', () => {
        const pane = paneHarness();
        pane.openRight({ tabId: 'files' });
        pane.openDetailsTab(createWorkspaceFileDetailsTab('README.md'), { intent: 'pinned' });
        toggleRightSidebarTab(pane, 'files', 'files', (id) => pane.openRight({ tabId: id }), true);
        expect(pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
        expect(pane.scopeState?.details.isOpen).toBe(false);
        expect(pane.scopeState?.details.tabs).toHaveLength(1);
    });

    it.each([false, true])('preserves sidebar open=%s when pinning, hiding, and refocusing Review', (rightOpen) => {
        const pane = paneHarness();
        if (rightOpen) pane.openRight({ tabId: 'files' });
        const originalRight = pane.scopeState?.right;
        pane.openDetailsTab(createWorkspaceFileDetailsTab('README.md'), { intent: 'pinned' });
        pane.closeDetails();
        toggleSessionReview(pane);
        expect(pane.scopeState?.right).toEqual(originalRight);
        expect(pane.scopeState?.details).toMatchObject({ isOpen: true, activeTabKey: SESSION_DETAILS_SCM_REVIEW_TAB_KEY });
        expect(pane.scopeState?.details.tabs.at(-1)).toMatchObject({ isPinned: true, isPreview: false });
        toggleSessionReview(pane);
        expect(pane.scopeState?.details.isOpen).toBe(false);
        expect(pane.scopeState?.details.tabs).toHaveLength(2);
        expect(pane.scopeState?.right).toEqual(originalRight);
        pane.openDetailsTab(createWorkspaceFileDetailsTab('README.md'), { intent: 'pinned' });
        toggleSessionReview(pane);
        expect(pane.scopeState?.details).toMatchObject({ isOpen: true, activeTabKey: SESSION_DETAILS_SCM_REVIEW_TAB_KEY });
        expect(pane.scopeState?.details.tabs).toHaveLength(2);
    });
});
