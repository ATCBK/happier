import * as React from 'react';
import type { Href } from 'expo-router';

import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardShortcutHandlers } from '@/keyboard/runtime';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { executeWorkspaceUiAction } from './workspaceActionRuntime';
import type { WorkspaceState } from './workspaceState';

/** Keyboard intent uses the same guarded Action owner as agent and menu operations. */
export function useWorkspaceKeyboardShortcuts(active: boolean, getState: () => WorkspaceState, openApproval: (href: Href) => void): void {
    const current = React.useRef({ active, getState, openApproval });
    current.current = { active, getState, openApproval };
    const handlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        if (!active) return {};
        const execute = (request: Parameters<typeof executeWorkspaceUiAction>[0]) => {
            if (!current.current.active) return;
            fireAndForget(executeWorkspaceUiAction(request, href => current.current.openApproval(href)), { tag: 'Workspace.keyboard' });
        };
        const focusedGroup = () => {
            const state = current.current.getState();
            return state.groups[state.focusedGroupId];
        };
        const result: KeyboardShortcutHandlers = {
            'workspace.tab.new': () => execute({ actionId: 'workspace.tabs.open', input: {} }),
            'workspace.tab.close': () => execute({ actionId: 'workspace.tabs.close', input: { tabId: focusedGroup().activeTabId } }),
            'workspace.tab.closeAll': () => execute({ actionId: 'workspace.tabs.close_all', input: { groupId: focusedGroup().id } }),
            'workspace.tab.reopen': () => execute({ actionId: 'workspace.tabs.reopen', input: {} }),
        };
        for (const position of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
            result[`workspace.tab.select${position}`] = () => {
                const tabIds = focusedGroup().tabIds;
                // Like a browser tab strip, 1–8 select a position and 9 selects the last tab.
                const tabId = position === 9 ? tabIds.at(-1) : tabIds[position - 1];
                if (tabId) execute({ actionId: 'workspace.tabs.activate', input: { tabId } });
            };
        }
        return result;
    }, [active]);
    useKeyboardShortcutHandlers(handlers);
}
