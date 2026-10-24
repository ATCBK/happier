import * as React from 'react';
import { useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';
import { createBrowserLaunchpadDetailsTab } from '@/components/browser/surfaces';
import { buildProjectTerminalDetailsInstanceId, openProjectTerminalDetailsTab } from './openProjectTerminalDetailsTab';
import { buildProjectRouteHref, readProjectSelectedRouteResource, type ProjectRouteSegment, type ProjectDetailsSourceSurface } from './projectRouteState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';

export function useProjectRouteActions(params: Readonly<{
    workspaceRef: WorkspaceRefV1 | null;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    showWorktrees?: boolean;
    sourceSurface?: ProjectDetailsSourceSurface | null;
    pane?: Pick<AppPaneScopeApi, 'scopeId' | 'openDetailsTab'> | null;
}>) {
    const paneContext = React.useContext(AppPaneContext);
    const routerRef = useProjectRouteRouterRef();
    const routeParams = useLocalSearchParams<Record<string, string | string[]>>();
    const pathname = usePathname();
    const page = resolveProjectCockpitRouteFromPathname(pathname)?.page ?? 'overview';
    const buildHref = React.useCallback((input?: Readonly<{
        segment?: ProjectRouteSegment;
        showWorktrees?: boolean;
        sourceSurface?: ProjectDetailsSourceSurface | null;
        workspaceRef?: WorkspaceRefV1;
    }>) => {
        const workspaceRef = input?.workspaceRef ?? params.workspaceRef;
        const details = params.pane ? paneContext?.getSnapshot().state.scopes[params.pane.scopeId]?.details : null;
        return workspaceRef ? buildProjectRouteHref({
            workspaceRefId: workspaceRef.id,
            serverId: workspaceRef.serverId,
            segment: input?.segment ?? page,
            routeParams,
            activeRootPath: input?.workspaceRef ? workspaceRef.rootPath : params.activeRootPath,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: input?.workspaceRef ? null : params.activeWorktreeId,
            showWorktrees: input?.showWorktrees ?? params.showWorktrees,
            sourceSurface: input?.sourceSurface ?? params.sourceSurface,
            initialResource: params.pane ? readProjectSelectedRouteResource(details ? buildDetailsWorkspaceStateView(details) : null) ?? null : undefined,
        }) : '/projects';
    }, [page, paneContext, params.activeRootPath, params.activeWorktreeId, params.pane?.scopeId, params.showWorktrees, params.sourceSurface, params.workspaceRef, routeParams]);
    const navigateToSegment = React.useCallback((input: Readonly<{
        segment?: ProjectRouteSegment;
        showWorktrees?: boolean;
        method?: 'push' | 'replace';
        sourceSurface?: ProjectDetailsSourceSurface | null;
        workspaceRef?: WorkspaceRefV1;
    }>) => {
        if (!params.workspaceRef) return;
        routerRef.current[input.method ?? 'push'](buildHref(input));
    }, [buildHref, params.workspaceRef, routerRef]);
    const replaceOverviewVisibility = React.useCallback((input: Readonly<{ segment?: ProjectRouteSegment; visible: boolean }>) => {
        navigateToSegment({ segment: input.visible ? 'overview' : input.segment ?? page, showWorktrees: input.visible, method: 'replace' });
    }, [navigateToSegment, page]);
    const openWorktreesInDetails = React.useCallback((method: 'push' | 'replace' = 'push') => {
        navigateToSegment({ segment: 'overview', showWorktrees: true, method });
    }, [navigateToSegment]);
    const openTerminal = React.useCallback((input?: Readonly<{ segment?: ProjectRouteSegment; exitOverview?: boolean }>) => {
        if (!params.workspaceRef || !params.pane) return;
        if (input?.exitOverview && params.showWorktrees) navigateToSegment({ segment: input.segment ?? page, showWorktrees: false, method: 'replace' });
        openProjectTerminalDetailsTab({
            openDetailsTab: params.pane.openDetailsTab,
            cwd: params.activeRootPath,
            terminalInstanceId: buildProjectTerminalDetailsInstanceId(params.workspaceRef.id),
        });
    }, [navigateToSegment, page, params.activeRootPath, params.pane, params.showWorktrees, params.workspaceRef]);
    const openBrowser = React.useCallback(() => {
        params.pane?.openDetailsTab(createBrowserLaunchpadDetailsTab(), { intent: 'pinned' });
    }, [params.pane]);
    return { buildHref, navigateToSegment, openBrowser, openTerminal, openWorktreesInDetails, replaceOverviewVisibility };
}
