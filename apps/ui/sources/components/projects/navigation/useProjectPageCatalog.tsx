import * as React from 'react';
import { useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiDeclarationSources, type AppShellPluginUiDeclarationSources } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { selectPluginPagePlacements, type PluginPageTarget } from '@/components/plugins/pages/pluginPages';
import { ProjectContextProvider, useProjectContext } from '@/components/projects/useProjectContext';
import { resolveProjectPageCatalogState, type ProjectPageDescriptor, type ProjectPageCatalogState } from '@/components/projects/detail/projectPageCatalog';
import { resolveProjectRouteSelectionQuery } from '@/components/projects/detail/projectRouteState';
import { resolveProjectCockpitRouteFromPathname, projectPageSelectionId, type ProjectPageSelection } from '@/components/workspaceCockpit/project/projectCockpitState';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useDeviceType } from '@/utils/platform/responsive';
import { usePublishProjectPageChrome } from './ProjectPageChromeContext';

type ProjectCatalogScope = Readonly<{
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    selection?: ProjectPageSelection;
}>;
export type ProjectPageCatalogModel = Readonly<{
    pages: readonly ProjectPageDescriptor[];
    routePages: readonly ProjectPageDescriptor[];
    activePageId: string;
    target: Extract<PluginPageTarget, { kind: 'project' }>;
    context: ReturnType<typeof useProjectContext>;
    projection: AppShellPluginUiDeclarationSources['projection'];
    authority: AppShellPluginUiDeclarationSources['accountLifetime'];
}>;
const Context = React.createContext<ProjectPageCatalogModel | null>(null);

/** One addressed Project lifetime supplies the body and desktop chrome; phone mounts the same owner. */
export function ProjectPageCatalogProvider(props: ProjectCatalogScope & Readonly<{ children: React.ReactNode }>) {
    const declarations = useAppShellPluginUiDeclarationSources();
    const visible = useDestinationVisibility();
    const phone = useDeviceType() === 'phone';
    const refs = useWorkspaceRefs();
    const locale = usePreferredLanguage();
    const routeParams = useLocalSearchParams<Record<string, string | string[]>>();
    const pathname = usePathname();
    const checkout = React.useMemo(() => resolveProjectCheckoutWorkspaceRef(refs, props.workspaceRef, props.activeRootPath),
        [refs, props.workspaceRef, props.activeRootPath]);
    const serverId = props.workspaceRef.serverId;
    const workspaceRefId = props.workspaceRef.id;
    const defaultRootPath = props.workspaceRef.rootPath;
    const context = useProjectContext({ serverId, projectRef: props.workspaceRef,
        activeCheckout: checkout, authority: declarations.accountLifetime });
    const target = React.useMemo((): Extract<PluginPageTarget, { kind: 'project' }> => ({ kind: 'project',
        workspaceRefId, serverId,
        ...resolveProjectRouteSelectionQuery({ activeRootPath: props.activeRootPath,
            defaultRootPath, activeWorktreeId: props.activeWorktreeId }) }),
        [workspaceRefId, serverId, defaultRootPath, props.activeRootPath, props.activeWorktreeId]);
    const localize = usePluginLocalizedTextResolver({ locale, projection: declarations.projection });
    const placements = React.useMemo(() => declarations.accountLifetime?.isCurrent() !== false
        && (!declarations.accountLifetime || areServerProfileIdentifiersEquivalent(declarations.accountLifetime.scope.serverId, serverId))
        ? selectPluginPagePlacements(declarations.projection, { container: 'appPage', targetKind: 'project' }) : [],
        [declarations.accountLifetime, declarations.projection, serverId]);
    const previous = React.useRef<Readonly<{ authority: typeof declarations.accountLifetime; target: typeof target;
        locale: typeof locale; state: ProjectPageCatalogState }> | null>(null);
    const baseline = previous.current?.authority === declarations.accountLifetime && previous.current.target === target
        && previous.current.locale === locale ? previous.current.state : undefined;
    const state = resolveProjectPageCatalogState({ target, placements, policyContext: context.policyContext, localize, baseline });
    previous.current = { authority: declarations.accountLifetime, target, locale, state };
    const mobileSurface = Array.isArray(routeParams.mobileSurface) ? routeParams.mobileSurface[0] : routeParams.mobileSurface;
    const route = React.useMemo(() => resolveProjectCockpitRouteFromPathname(pathname, null, mobileSurface), [pathname, mobileSurface]);
    const selection: ProjectPageSelection = props.selection ?? route?.selection ?? { kind: 'builtin', page: route?.page ?? 'overview' };
    const activePageId = projectPageSelectionId(selection);
    const value = React.useMemo(() => ({ pages: state.pages, routePages: state.routePages, activePageId, target, context,
        projection: declarations.projection, authority: declarations.accountLifetime }),
        [state, activePageId, target, context, declarations.projection, declarations.accountLifetime]);
    usePublishProjectPageChrome(value, phone && visible && declarations.accountLifetime?.isCurrent() !== false);
    return <ProjectContextProvider value={context}><Context.Provider value={value}>{props.children}</Context.Provider></ProjectContextProvider>;
}

export function useProjectPageCatalog(): ProjectPageCatalogModel {
    const value = React.useContext(Context);
    if (!value) throw new Error('Project page catalog requires its addressed Project provider');
    return value;
}

export function useOptionalProjectPageCatalog(): ProjectPageCatalogModel | null {
    return React.useContext(Context);
}
