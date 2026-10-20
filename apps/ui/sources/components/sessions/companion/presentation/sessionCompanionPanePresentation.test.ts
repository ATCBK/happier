import { describe, expect, it } from 'vitest';

import { appPaneReduce, createAppPaneState, type AppPaneAction } from '@/components/appShell/panes/model/appPaneReducer';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { createSessionBoardDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

import { createSessionCompanionPanePresentation } from './sessionCompanionPanePresentation';

function createHarness() {
    const scopeId = 'session:presentation';
    let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
    let undoCurrent = true;
    let controlsAvailable = true;
    const dispatch = (action: AppPaneAction) => { state = appPaneReduce(state, action); };
    const presentation = createSessionCompanionPanePresentation({
        isUndoCurrent: () => undoCurrent,
        readMainColumn: () => controlsAvailable ? {
            hidden: state.scopes[scopeId].mainHidden,
            setHidden: (hidden: boolean) => dispatch({ type: 'setMainHidden', scopeId, hidden }),
        } : null,
        readPane: () => ({
            scopeState: { ...state.scopes[scopeId], details: buildDetailsWorkspaceStateView(state.scopes[scopeId].details) },
            openDetailsTab: (tab) => dispatch({ type: 'openDetailsTab', scopeId, tab, openAs: 'pinned' }),
            setActiveDetailsTab: tabKey => dispatch({ type: 'setActiveDetailsTab', scopeId, tabKey }),
            closeDetails: () => dispatch({ type: 'closeDetails', scopeId }),
            closeDetailsTab: tabKey => dispatch({ type: 'closeDetailsTab', scopeId, tabKey }),
            focusDetailsGroup: groupId => dispatch({ type: 'focusDetailsGroup', scopeId, groupId }),
        }),
    });
    return { presentation, scope: () => state.scopes[scopeId], dispatch,
        retire: () => { undoCurrent = false; },
        withdrawControls: () => { controlsAvailable = false; }, scopeId };
}

describe('Session companion pane presentation', () => {
    it('requires measured main-column controls only for visibility changes and preserves pane navigation without them', () => {
        const host = createHarness();
        host.withdrawControls();
        expect(host.presentation.openBoard('focus').status).toBe('unavailable');
        expect(host.presentation.returnToChat().status).toBe('unavailable');
        expect(buildDetailsWorkspaceStateView(host.scope().details).isOpen).toBe(false);
        expect(host.presentation.openBoard('beside_chat').status).toBe('applied');
        const revealed = host.presentation.revealBoardItem('chart');
        expect(revealed.status).toBe('applied');
        expect(buildDetailsWorkspaceStateView(host.scope().details).activeTabKey).toBe(createSessionBoardDetailsTab({ kind: 'item', itemId: 'chart' }).key);
        revealed.undo?.();
        expect(buildDetailsWorkspaceStateView(host.scope().details).activeTabKey).toBe(createSessionBoardDetailsTab().key);
        expect(host.scope().mainHidden).toBe(false);
    });

    it('opens a focused Board through the real pane state and returns to Chat without closing its panes', () => {
        const host = createHarness();
        host.dispatch({ type: 'openRight', scopeId: host.scopeId, tabId: 'git' });
        expect(host.presentation.openBoard('focus').status).toBe('applied');
        expect(host.scope().mainHidden).toBe(true);
        expect(buildDetailsWorkspaceStateView(host.scope().details).activeTabKey).toBe(createSessionBoardDetailsTab().key);
        expect(host.presentation.openBoard('focus').status).toBe('unchanged');
        const details = host.scope().details;
        const right = host.scope().right;
        const returned = host.presentation.returnToChat();
        expect(returned.status).toBe('applied');
        expect(host.scope().mainHidden).toBe(false);
        expect(host.scope().details).toBe(details);
        expect(host.scope().right).toBe(right);
        returned.undo?.();
        expect(host.scope().mainHidden).toBe(true);
        expect(host.presentation.openBoard('beside_chat').status).toBe('applied');
        expect(host.scope().mainHidden).toBe(false);
    });

    it('preserves visibility for item reveal and refuses stale or superseded visibility inverses', () => {
        const host = createHarness();
        host.presentation.openBoard('focus');
        host.presentation.revealBoardItem('chart');
        expect(host.scope().mainHidden).toBe(true);
        const returned = host.presentation.returnToChat();
        host.retire();
        returned.undo?.();
        expect(host.scope().mainHidden).toBe(false);

        const next = createHarness();
        const opened = next.presentation.openBoard('focus');
        next.dispatch({ type: 'setMainHidden', scopeId: next.scopeId, hidden: false });
        opened.undo?.();
        expect(next.scope().mainHidden).toBe(false);
        expect(next.presentation.returnToChat().status).toBe('unchanged');
    });

    it('undoes a focused Board open back to the prior details selection and visibility', () => {
        const host = createHarness();
        const fileTab = { key: 'file:readme', kind: 'file', title: 'README.md', resource: { path: 'README.md' } };
        host.dispatch({ type: 'openDetailsTab', scopeId: host.scopeId, tab: fileTab, openAs: 'pinned' });
        const opened = host.presentation.openBoard('focus');
        expect(host.scope().mainHidden).toBe(true);
        opened.undo?.();
        const details = buildDetailsWorkspaceStateView(host.scope().details);
        expect(host.scope().mainHidden).toBe(false);
        expect(details.activeTabKey).toBe(fileTab.key);
        expect(details.tabs.map(tab => tab.key)).toEqual([fileTab.key]);
    });
});
