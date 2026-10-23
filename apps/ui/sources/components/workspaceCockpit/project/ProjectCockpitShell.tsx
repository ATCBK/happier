import * as React from 'react';
import { View } from 'react-native';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { ProjectDetailsMainPanel } from '@/components/projects/detail/ProjectDetailsMainPanel';
import { ProjectOverviewWidgets } from '@/components/projects/detail/ProjectOverviewWidgets';
import { ProjectBrowseFilesSurface } from '@/components/projects/detail/surfaces/ProjectBrowseFilesSurface';
import { ProjectGitSurface } from '@/components/projects/detail/surfaces/ProjectGitSurface';
import { ProjectTerminalSurface } from '@/components/projects/detail/surfaces/ProjectTerminalSurface';
import { ProjectRightPanelBrowserView } from '@/components/projects/detail/browser/ProjectRightPanelBrowserView';
import { ProjectRightPanelServicesView } from '@/components/projects/detail/services/ProjectRightPanelServicesView';
import { ProjectScriptsBody } from '@/components/projects/projectSetup/ProjectScriptsBody';
import { ProjectContextBody } from '@/components/projects/context/ProjectContextBody';
import { ProjectMemoryBody } from '@/components/projects/memory/ProjectMemoryBody';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useDeviceType } from '@/utils/platform/responsive';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useProjectSurfaceActions } from '@/components/projects/detail/useProjectSurfaceActions';
import { useProjectSurfaceController } from '@/components/projects/detail/useProjectSurfaceController';
import { useProjectRouteSurfaceSync } from '@/components/projects/detail/useProjectRouteSurfaceSync';
import { CheckoutReachabilityLine, CheckoutReachabilityScope } from '@/components/workspaces/reachability/checkoutReachability';
import type { ProjectMobileSurface, ProjectAttachedDashboardSelection } from './projectCockpitState';

type ProjectCockpitShellProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    layoutId?: string;
    attachedDashboard?: ProjectAttachedDashboardSelection;
    surface: ProjectMobileSurface;
    isFocused: boolean;
    onSelectRootPath: (path: string) => void;
}>;

/**
 * The Project's page under its header. When the checkout's machine isn't answering, the page says so
 * once here, above every page; the surfaces below inherit it (see `checkoutReachability`).
 */
export const ProjectCockpitShell = React.memo((props: ProjectCockpitShellProps) => (
    <CheckoutReachabilityScope scope={props.workspaceRef}>
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            {/* Context and Memory lead with their own header and read memory, not the checkout. */}
            {props.surface === 'context' || props.surface === 'memory' ? null : <CheckoutReachabilityLine scope={props.workspaceRef} testID="project-checkout-reachability" />}
            <ProjectCockpitSurface {...props} />
        </View>
    </CheckoutReachabilityScope>
));

const ProjectCockpitSurface = React.memo((props: ProjectCockpitShellProps) => {
    const { navigateToSurface, selectDashboard, checkoutWorkspace, codeLocation, navigateCodeLocation, openCodeHistory } = useProjectSurfaceController({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        activeWorktreeId: props.activeWorktreeId,
    });
    useProjectRouteSurfaceSync({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        activeWorktreeId: props.activeWorktreeId,
        isFocused: props.isFocused,
        surface: props.surface,
    });

    const workspaceScope = React.useMemo((): WorkspaceScopeBase => ({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.activeRootPath,
    }), [props.activeRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);

    const navigateToBrowse = React.useCallback(() => {
        navigateToSurface('browse');
    }, [navigateToSurface]);

    const {
        openFileInDetails,
        openFileInDetailsPinned,
        openReviewAllChanges,
        openStashDetails,
        openCreateWorktreeFlow,
        openCommitInDetails,
        revealInFilesTree,
    } = useProjectSurfaceActions({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        onRevealInFilesTreeNavigate: navigateToBrowse,
    });

    if (props.surface === 'code' || props.surface === 'browse') {
        // Code is one wide column (plan 13, lab p-code BROWSE): widgets live on Overview only.
        const browser = <React.Suspense fallback={<PaneLoadingFallback />}>
            <ProjectBrowseFilesSurface
                workspaceRef={props.workspaceRef}
                activeWorktreeId={props.activeWorktreeId}
                scopeId={props.scopeId}
                scope={workspaceScope}
                onOpenFile={openFileInDetails}
                onOpenFilePinned={openFileInDetailsPinned}
                {...(props.surface === 'code' ? { location: codeLocation, onNavigate: navigateCodeLocation, onOpenHistory: openCodeHistory } : {})}
            />
        </React.Suspense>;
        return (
            <View testID="project-files-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                {browser}
            </View>
        );
    }

    if (props.surface === 'changes' || props.surface === 'git') {
        return (
            <View testID="project-git-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <ProjectGitSurface
                        scopeId={props.scopeId}
                        serverId={props.workspaceRef.serverId}
                        machineId={props.workspaceRef.machineId}
                        rootPath={props.activeRootPath}
                        onOpenFile={openFileInDetails}
                        onOpenFilePinned={openFileInDetailsPinned}
                        onOpenReviewAllChanges={openReviewAllChanges}
                        onOpenStashDetails={openStashDetails}
                        onOpenCommit={openCommitInDetails}
                        onSelectWorkspacePath={props.onSelectRootPath}
                        onRequestCreateWorktreeFromAnotherBranch={openCreateWorktreeFlow}
                        onRevealInFilesTree={revealInFilesTree}
                    />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'terminal') {
        return (
            <View testID="project-terminal-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <ProjectTerminalSurface
                        scopeId={props.scopeId}
                        workspaceRefId={props.workspaceRef.id}
                        machineId={props.workspaceRef.machineId}
                        rootPath={props.activeRootPath}
                        serverId={props.workspaceRef.serverId}
                        workspace={checkoutWorkspace}
                    />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'browser') {
        return (
            <View testID="project-browser-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <ProjectRightPanelBrowserView workspaceRefId={props.workspaceRef.id} scopeId={`${props.scopeId}:browser`} workspaceScope={workspaceScope} />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'services') {
        return <ProjectServicesSurface {...props} navigateToSurface={navigateToSurface} />;
    }

    if (props.surface === 'overview') {
        return <ProjectOverviewWidgets workspaceRef={props.workspaceRef} activeRootPath={props.activeRootPath} activeWorktreeId={props.activeWorktreeId} layoutId={props.layoutId}
            attachedDashboard={props.attachedDashboard}
            onSelectDashboard={selectDashboard} />;
    }

    const openServices = () => navigateToSurface('services');
    if (props.surface === 'scripts') {
        return checkoutWorkspace ? <ProjectScriptsBody workspace={checkoutWorkspace} testID="project-scripts-screen" onOpenServices={openServices} outputScopeId={props.scopeId} />
            : <SurfaceStateCard testID="project-scripts-unavailable" kind="unavailable" title={t('common.unavailable')} />;
    }

    if (props.surface === 'context') {
        return <ProjectContextBody workspaceRef={props.workspaceRef} testID="project-context-screen" />;
    }

    if (props.surface === 'memory') {
        return <ProjectMemoryBody workspaceRef={props.workspaceRef} testID="project-memory-screen" />;
    }

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <ProjectDetailsMainPanel
                workspaceRef={props.workspaceRef}
                scopeId={props.scopeId}
                activeRootPath={props.activeRootPath}
                activeWorktreeId={props.activeWorktreeId}
                onSelectRootPath={props.onSelectRootPath}
            />
        </View>
    );
});

const ProjectServicesSurface = React.memo((props: ProjectCockpitShellProps & Readonly<{
    navigateToSurface: (surface: ProjectMobileSurface) => void;
}>) => {
    const isPhone = useDeviceType() === 'phone';
    const switchToBrowserSurface = React.useCallback(() => {
        props.navigateToSurface('browser');
    }, [props.navigateToSurface]);
    const addService = React.useCallback(() => {
        props.navigateToSurface('scripts');
    }, [props.navigateToSurface]);
    const { binding: accountLifetime } = useServerCredentialAccountScopeBinding(props.workspaceRef.serverId);
    // Desktop opens into this Project's details pane. Phones own a separate full-screen
    // Browser workspace and switch to it only after the shared opener commits its tab.
    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: isPhone ? `${props.scopeId}:browser` : props.scopeId,
        scope: isPhone ? 'sessionMobile' : 'workspaceDetails',
        accountLifetime,
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
        onAfterOpen: isPhone ? switchToBrowserSurface : undefined,
    });

    return (
        <View testID="project-services-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <React.Suspense fallback={<PaneLoadingFallback />}>
                <ProjectRightPanelServicesView
                    machineId={props.workspaceRef.machineId}
                    workspaceRefId={props.workspaceRef.id}
                    serverId={props.workspaceRef.serverId}
                    workspaceRoot={props.activeRootPath}
                    onOpenServiceInBrowser={openServiceInBrowser}
                    presentation="page"
                    onAddService={addService}
                    testID="project-services-page"
                />
            </React.Suspense>
        </View>
    );
});
