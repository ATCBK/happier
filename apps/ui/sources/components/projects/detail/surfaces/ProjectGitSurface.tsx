import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useWorkspaceScmTabState } from '@/components/workspaces/scm/useWorkspaceScmTabState';
import * as React from 'react';
import { View } from 'react-native';

import { WorkspaceRightPanelGitView } from '@/components/projects/scm/WorkspaceRightPanelGitView';
import { WorkspaceScmReviewDetailsView, type WorkspaceScmReviewDetailsViewProps } from '@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView';
import { useScmReviewTabState } from '@/components/sessions/files/comparison/useSessionScmReviewTabState';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';
import { useDestinationParams } from '@/components/appShell/workspace/DestinationInstanceHost';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useProjectSessions, useSessionListRowRenderablesForItems, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { projectReviewEvidenceSessions, type ProjectReviewEvidenceSession } from './projectReviewEvidenceSessions';
import { SESSION_DETAILS_SCM_REVIEW_TAB_KEY } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

/** Only the mounted review demands the canonical, separately admitted Project roster. */
function ProjectReviewSurface(props: WorkspaceScmReviewDetailsViewProps) {
    const refs = useWorkspaceRefs();
    const checkout = findWorkspaceRefByScope(refs, props);
    const project = React.useMemo(() => checkout ? projectWorkspaceRefV1(checkout) : null,
        [checkout?.serverId, checkout?.projectKey, checkout?.id]);
    const roster = useProjectSessions(project);
    const rows = useSessionListRowRenderablesForItems(roster.items);
    const publishedEvidence = React.useRef<readonly ProjectReviewEvidenceSession[] | undefined>(undefined);
    const evidenceSessions = React.useMemo(() => {
        const next = projectReviewEvidenceSessions(roster.items, rows, props, publishedEvidence.current);
        publishedEvidence.current = next;
        return next;
    }, [roster.items, rows, props.machineId, props.rootPath]);
    return <WorkspaceScmReviewDetailsView {...props} evidenceSessions={evidenceSessions} />;
}

export const ProjectGitSurface = React.memo((props: Readonly<{
    scopeId: string;
    serverId: string;
    machineId: string;
    rootPath: string;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned: (fullPath: string) => void;
    onOpenReviewAllChanges: () => void;
    onOpenStashDetails: () => void;
    onOpenCommit: (sha: string) => void;
    onSelectWorkspacePath: (path: string) => void;
    onRequestCreateWorktreeFromAnotherBranch: () => void;
    onRevealInFilesTree: (fullPath: string) => void;
}>) => {
    const pane = useAppPaneScope(props.scopeId, scope => ({
        gitTabState: scope?.right.tabState.git,
        reviewTabState: scope?.details.tabState[SESSION_DETAILS_SCM_REVIEW_TAB_KEY],
    }));
    const params = useDestinationParams<Record<string, string | string[] | undefined>>();
    const routeResource = parseSessionPaneUrlState(params)?.details;
    const { activeGitSubTab, setActiveGitSubTab } = useWorkspaceScmTabState({
        scopeState: { right: { tabState: { git: pane.scopeState.gitTabState } } }, setRightTabState: pane.setRightTabState,
    });
    const { persistedReviewTabState, setPersistedReviewTabState } = useScmReviewTabState(
        JSON.stringify([props.serverId, props.machineId, props.rootPath]), { patchDetailsTabState: pane.patchDetailsTabState },
        SESSION_DETAILS_SCM_REVIEW_TAB_KEY, pane.scopeState.reviewTabState);
    const mode = persistedReviewTabState?.projectChangesMode === 'git' ? 'git' : 'review';
    // Review | Git leads the review's own comparison bar (one line of chrome); in Git it heads Git's pane.
    const modeSwitch = <SegmentedTabBar tabs={[{ id: 'review', label: t('files.toolbar.review') }, { id: 'git', label: t('session.rightPanel.tabs.git') }]}
        activeTabId={mode} onSelectTab={(next) => setPersistedReviewTabState({ projectChangesMode: next })}
        testIDPrefix="project-changes-mode" segmentSizing="content" />;
    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            {mode === 'git' ? modeSwitch : null}
            {mode === 'review' ? <ProjectReviewSurface scopeId={props.scopeId} hostSwitch={modeSwitch}
                {...(routeResource?.kind === 'scmReview' ? routeResource : {})}
                serverId={props.serverId} machineId={props.machineId} rootPath={props.rootPath}
                onOpenFile={props.onOpenFile} onOpenFilePinned={props.onOpenFilePinned}
                onShowInGit={() => { setPersistedReviewTabState({ projectChangesMode: 'git' }); setActiveGitSubTab('commit'); }} /> : <WorkspaceRightPanelGitView
            activeSubTabId={activeGitSubTab}
            onActiveSubTabChange={setActiveGitSubTab}
            serverId={props.serverId}
            machineId={props.machineId}
            rootPath={props.rootPath}
            onOpenFile={props.onOpenFile}
            onOpenFilePinned={props.onOpenFilePinned}
            onOpenReviewAllChanges={props.onOpenReviewAllChanges}
            onOpenStashDetails={props.onOpenStashDetails}
            onOpenCommit={props.onOpenCommit}
            onSelectWorkspacePath={props.onSelectWorkspacePath}
            onRequestCreateWorktreeFromAnotherBranch={props.onRequestCreateWorktreeFromAnotherBranch}
            onRevealInFilesTree={props.onRevealInFilesTree}
        />}
        </View>
    );
});
