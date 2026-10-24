import * as React from 'react';

import type { GitSubTabId } from '@/components/workspaces/scm/WorkspaceScmSubTabsBar';

type PaneLike = Readonly<{
    scopeState: unknown;
    setRightTabState: (tabId: string, state: unknown) => void;
}>;

function readGitTabState(scopeState: unknown): Record<string, unknown> | null {
    if (!scopeState || typeof scopeState !== 'object' || !('right' in scopeState)) return null;
    const right = scopeState.right;
    if (!right || typeof right !== 'object' || !('tabState' in right)) return null;
    const tabState = right.tabState;
    if (!tabState || typeof tabState !== 'object' || !('git' in tabState)) return null;
    const git = tabState.git;
    return git && typeof git === 'object' ? (git as Record<string, unknown>) : null;
}

export function useWorkspaceScmTabState(pane: PaneLike): Readonly<{
    activeGitSubTab: GitSubTabId;
    commitDraftMessage: string;
    setCommitDraftMessage: (value: string) => void;
    setActiveGitSubTab: (subTabId: GitSubTabId) => void;
}> {
    const gitTabState = readGitTabState(pane.scopeState);
    const activeGitSubTab = (gitTabState?.activeSubTabId as GitSubTabId | null) ?? 'commit';
    const commitDraftMessage = typeof gitTabState?.commitMessageDraft === 'string' ? (gitTabState.commitMessageDraft as string) : '';
    const setRightTabState = pane.setRightTabState;

    const setCommitDraftMessage = React.useCallback((value: string) => {
        const base = gitTabState ?? {};
        setRightTabState('git', { ...base, commitMessageDraft: value });
    }, [gitTabState, setRightTabState]);

    const setActiveGitSubTab = React.useCallback((subTabId: GitSubTabId) => {
        const base = gitTabState ?? {};
        setRightTabState('git', { ...base, activeSubTabId: subTabId });
    }, [gitTabState, setRightTabState]);

    return {
        activeGitSubTab,
        commitDraftMessage,
        setCommitDraftMessage,
        setActiveGitSubTab,
    };
}
