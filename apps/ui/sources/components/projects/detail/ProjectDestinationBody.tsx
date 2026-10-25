import * as React from 'react';
import { Stack, useIsFocused, useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from './projectPaneScope';
import { useProjectInitialResource } from './useProjectInitialResource';
import { useProjectRouteActions } from './useProjectRouteActions';
import { ProjectPageBackProvider } from './projectPageBack';
import { useProjectRouteHeaderOptions } from './useProjectRouteHeaderOptions';
import { PROJECT_ROUTE_ROOT_SENTINEL, readProjectAttachedDashboardSelection, readProjectRouteStringParam, readProjectRouteWorktreeSelection, readProjectSelectedRouteResource, replaceProjectRouteSelection } from './projectRouteState';
import { useWorkspaceRefResolutionById } from './useWorkspaceRefById';
import { resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';
import { useLocalSetting, usePersistProjectLastMobileSurface, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readProjectSelectionPreference, resolveProjectSelectionPreferenceKeys, writeProjectSelectionPreference } from '@/sync/domains/settings/projectSelectionPersistence';

export const ProjectDestinationBody = React.memo(() => {
    const routerRef = useProjectRouteRouterRef();
    const isFocused = useIsFocused();
    const pathname = usePathname();
    const params = useLocalSearchParams<Record<string, string | string[]>>();
    const workspaceRefId = readProjectRouteStringParam(params.workspaceRefId) ?? '';
    const serverId = readProjectRouteStringParam(params.serverId);
    const workspaceResolution = useWorkspaceRefResolutionById(workspaceRefId, serverId);
    const workspaceRef = workspaceResolution.kind === 'resolved' ? workspaceResolution.ref : null;
    const workspaceRefs = useWorkspaceRefs();
    const preferenceKeys = React.useMemo(() => workspaceRef
        ? resolveProjectSelectionPreferenceKeys(workspaceRefs, workspaceRef) : null, [workspaceRef, workspaceRefs]);
    const pageRoute = resolveProjectCockpitRouteFromPathname(pathname, null, readProjectRouteStringParam(params.mobileSurface));
    const page = pageRoute?.page ?? 'overview';
    const surface = pageRoute?.surface ?? page;
    const showWorktrees = readProjectRouteStringParam(params.showWorktrees) === '1';
    const scopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(workspaceRefId, workspaceRef?.serverId ?? serverId));
    const pane = useAppPaneScope(scopeId, () => null);
    const paneContext = React.useContext(AppPaneContext);
    const resourcePending = useProjectInitialResource(pane, workspaceRef);
    const roots = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const worktreeIds = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const persistPage = usePersistProjectLastMobileSurface();
    const fallbackRootPath = workspaceRef?.rootPath ?? readProjectRouteStringParam(params.activeRootPath) ?? '';
    const selection = readProjectRouteWorktreeSelection({
        rawWorktreeId: params.worktreeId,
        rawLegacyActiveRootPath: params.activeRootPath,
        defaultRootPath: fallbackRootPath,
        persistedActiveRootPath: readProjectSelectionPreference(roots, preferenceKeys),
        persistedWorktreeId: readProjectSelectionPreference(worktreeIds, preferenceKeys),
    });
    const { requestedRootPath, didRecoverMissingWorktree, resolvedRootPath: activeRootPath, resolvedWorktreeId: activeWorktreeId, availableWorktrees } = useResolvedRepoWorktreeSelection({
        serverId: workspaceRef?.serverId ?? serverId ?? '',
        machineId: workspaceRef?.machineId ?? '',
        defaultRootPath: fallbackRootPath,
        requestedRootPath: selection.requestedRootPath,
        requestedWorktreeId: selection.requestedWorktreeId,
    });
    const replaceSelection = React.useCallback((path: string, nextShowWorktrees = showWorktrees) => {
        if (!workspaceRef || !path.trim()) return;
        const details = paneContext?.getSnapshot().state.scopes[scopeId]?.details;
        replaceProjectRouteSelection({
            router: routerRef.current,
            workspaceRefId,
            serverId: workspaceRef.serverId,
            segment: page,
            surface,
            routeParams: params,
            initialResource: readProjectSelectedRouteResource(details ? buildDetailsWorkspaceStateView(details) : null) ?? (resourcePending ? undefined : null),
            activeRootPath: path,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: path === workspaceRef.rootPath ? null : findVisibleRepoWorktreeByPath(availableWorktrees, path)?.id ?? null,
            showWorktrees: nextShowWorktrees,
        });
    }, [availableWorktrees, page, paneContext, scopeId, params, resourcePending, routerRef, showWorktrees, surface, workspaceRef, workspaceRefId]);
    const selectRootPath = React.useCallback((path: string) => replaceSelection(path), [replaceSelection]);
    React.useEffect(() => {
        if (!isFocused || !workspaceRef || !preferenceKeys) return;
        persistPage(workspaceRefId, page, workspaceRef.serverId);
        const worktreeId = activeWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL;
        if (roots?.[preferenceKeys.storageKey] === activeRootPath && worktreeIds?.[preferenceKeys.storageKey] === worktreeId) return;
        getStorage().getState().applyLocalSettings({
            ...(roots?.[preferenceKeys.storageKey] !== activeRootPath ? {
                projectLastActiveRootPathByWorkspaceRefId: writeProjectSelectionPreference(roots, preferenceKeys, activeRootPath),
            } : {}),
            ...(worktreeIds?.[preferenceKeys.storageKey] !== worktreeId ? {
                projectLastActiveWorktreeIdByWorkspaceRefId: writeProjectSelectionPreference(worktreeIds, preferenceKeys, worktreeId),
            } : {}),
        }, { source: 'ui' });
    }, [activeRootPath, activeWorktreeId, isFocused, page, persistPage, preferenceKeys, roots, worktreeIds, workspaceRef, workspaceRefId]);
    const setShowWorktrees = React.useCallback((value: boolean) => replaceSelection(activeRootPath, value), [activeRootPath, replaceSelection]);
    const actions = useProjectRouteActions({ workspaceRef, activeRootPath, activeWorktreeId, showWorktrees, pane });
    // A page's pushed detail (a phone Service) takes the bar's Back while it is open; otherwise Back leaves the Project.
    const [pageBack, setPageBack] = React.useState<(() => void) | null>(null);
    const registerPageBack = React.useCallback((back: (() => void) | null) => setPageBack(() => back), []);
    const screenOptions = useProjectRouteHeaderOptions({
        workspaceRef,
        activeRootPath,
        testIdPrefix: 'project-header',
        showWorktreesButton: true,
        ...(pageBack ? { onBack: pageBack } : {}),
        onToggleWorktrees: () => actions.replaceOverviewVisibility({ visible: !showWorktrees }),
        onOpenBrowser: actions.openBrowser,
        onOpenTerminal: () => actions.openTerminal({ exitOverview: true }),
    });
    return <ProjectPageBackProvider value={registerPageBack}>
        <Stack.Screen options={screenOptions} />
        <ProjectDetailScreen
            workspaceRefId={workspaceRefId}
            serverId={serverId}
            workspaceResolution={workspaceResolution}
            layoutId={readProjectRouteStringParam(params.layoutId) ?? undefined}
            attachedDashboard={readProjectAttachedDashboardSelection(params)}
            recoveryToastKey={didRecoverMissingWorktree ? `${workspaceRefId}:${requestedRootPath}` : null}
            page={page}
            surface={surface}
            activeRootPath={activeRootPath}
            activeWorktreeId={activeWorktreeId}
            isFocused={isFocused}
            showWorktrees={showWorktrees}
            onSelectRootPath={selectRootPath}
            onSetShowWorktrees={setShowWorktrees}
        />
    </ProjectPageBackProvider>;
});
