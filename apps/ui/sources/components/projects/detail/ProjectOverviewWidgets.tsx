import * as React from 'react';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { ProjectOverviewLayout, PROJECT_OVERVIEW_AREA_GAP_PX, type ProjectOverviewArrangement } from '@/components/projects/overview/ProjectOverviewLayout';
import { ProjectDashboardIdentityLine } from '@/components/projects/overview/ProjectDashboardIdentityLine';
import { useProjectDashboardOwner } from '@/components/projects/overview/useProjectDashboardOwner';
import { ProjectDashboardHeader } from '@/components/projects/overview/ProjectDashboardHeader';
import { WidgetArea } from '@/components/widgets/area/WidgetArea';
import { useProjectWidgetAreaBinding } from '@/components/widgets/area/ProjectWidgetArea';
import { useWidgetAreaLayout, type WidgetAreaLayout, type WidgetAreaPort } from '@/components/widgets/area/useWidgetAreaLayout';
import { WidgetAreaPresetLine } from '@/components/widgets/area/WidgetAreaPresetLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { useDeviceType } from '@/utils/platform/responsive';
import { useActiveServerAccountScope, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import { t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import { mergeProjectOverviewWidgetHeads, projectOverviewWidgetAreas, readProjectOverviewWidgetAreas } from './projectOverviewPlacements';
import type { ProjectAttachedDashboardSelection } from './projectRouteState';

/** Non-visual binding: the selected dashboard reads once; all frames use the canonical WidgetArea. */
export function ProjectOverviewWidgets(props: Readonly<{
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    projectName?: string;
    layoutId?: string;
    artifactId?: string;
    ownerAccountId?: string;
    attachedDashboard?: ProjectAttachedDashboardSelection;
    onSelectDashboard: (layoutId: string | null) => void;
    /** A9 supplies the selected-document controller; U1 owns its visual dashboard bar. */
    bar?: React.ReactNode;
}>): React.ReactElement {
    const projectName = props.projectName ?? resolveWorkspaceRefDisplayName(props.workspaceRef);
    const refs = useWorkspaceRefs();
    const activeCheckout = React.useMemo(() => resolveProjectCheckoutWorkspaceRef(refs, props.workspaceRef, props.activeRootPath) ?? undefined,
        [props.activeRootPath, props.workspaceRef, refs]);
    const binding = useProjectWidgetAreaBinding({ serverId: props.workspaceRef.serverId, projectName, projectRef: props.workspaceRef, activeCheckout,
        layoutId: props.layoutId, artifactId: props.artifactId, ownerAccountId: props.ownerAccountId, attachedDashboard: props.attachedDashboard,
        onSelectLayout: props.onSelectDashboard });
    // The bar is the Overview's own dashboard header unless a host supplies another (a Team Source view).
    const bar = props.bar ?? <ProjectDashboardHeader workspaceRef={props.workspaceRef}
        activeRootPath={props.activeRootPath} activeWorktreeId={props.activeWorktreeId} projectName={projectName} layoutId={props.layoutId ?? null}
        attachedDashboard={props.attachedDashboard} sharedDashboard={binding.sharedDashboard} />;
    if (!binding.port) return <ProjectOverviewLayout bar={bar} identity={null}
        blocking={binding.unavailableReasonCode === 'widget_area_loading'
            ? <SurfaceStateCard kind="loading" title={t('common.loading')} testID="project-overview.loading" />
            : <WidgetArea port={null} context={binding.context} geometry="column" title={projectName}
            surfaceName={projectName} unavailable={{ title: t('projects.widgets.layoutUnavailable'), reasonCode: binding.unavailableReasonCode ?? 'widget_area_unavailable' }}
            testID="project-overview-state" />} main={null} aside={null} />;
    return <ProjectOverviewDocument port={binding.port} context={binding.context} projectName={projectName} bar={bar} />;
}

/** Kept at the real port boundary so the admitted document is shared across both responsive hosts. */
export function ProjectOverviewDocument(props: Readonly<{
    port: WidgetAreaPort;
    context: WidgetSurfaceContext;
    projectName: string;
    bar?: React.ReactNode;
}>): React.ReactElement {
    const layout = useWidgetAreaLayout(props.port, props.context);
    const preset = layout.state.status === 'ready' ? layout.state.preset ?? null : null;
    const presetSurface = layout.state.status === 'ready' ? layout.state.surface : null;
    const phone = useDeviceType() === 'phone';
    const [arrangement, setArrangement] = React.useState<ProjectOverviewArrangement>('columns');
    const [organizing, setOrganizing] = React.useState(false);
    const organize = React.useMemo(() => ({ active: organizing, onChange: setOrganizing }), [organizing]);
    const viewer = useActiveServerAccountScope();
    const disclosureScope = layout.state.status === 'ready'
        ? stableJsonStringify({ surface: layout.state.surface, viewer }) : '';
    const [disclosures, setDisclosures] = React.useState<Readonly<{
        scope: string; values: Readonly<Record<string, boolean>>;
    }>>({ scope: '', values: {} });
    const onCollapsedChange = React.useCallback((instanceId: string, collapsed: boolean) => {
        setDisclosures(previous => ({ scope: disclosureScope,
            values: { ...(previous.scope === disclosureScope ? previous.values : {}), [instanceId]: collapsed } }));
    }, [disclosureScope]);
    const disclosure = React.useMemo(() => ({
        collapsedByInstanceId: disclosures.scope === disclosureScope ? disclosures.values : {}, onCollapsedChange,
    }), [disclosureScope, disclosures, onCollapsedChange]);
    const rawAreas = React.useMemo(() => layout.state.status === 'ready'
        ? readProjectOverviewWidgetAreas(layout.state.documentState === 'missing' ? null : {
            v: 1, surface: layout.state.surface, instances: layout.state.placements,
        }) : null, [layout.state]);
    const areas = React.useMemo(() => rawAreas ? projectOverviewWidgetAreas(rawAreas) : null, [rawAreas]);
    const merged = React.useMemo(() => rawAreas ? mergeProjectOverviewWidgetHeads(rawAreas) : null, [rawAreas]);
    const projections = React.useMemo(() => {
        const projectLayout = (placements: readonly NonNullable<typeof merged>[number][] | null): WidgetAreaLayout<WidgetSurfaceContext> => ({
            ...layout, state: layout.state.status === 'ready' && placements ? { ...layout.state, placements: [...placements] } : layout.state,
        });
        return { main: projectLayout(areas?.main ?? null), aside: projectLayout(areas?.aside ?? null), phone: projectLayout(merged) };
    }, [areas, layout, merged]);
    const shared = { port: props.port, context: props.context, geometry: 'column' as const, title: props.projectName,
        surfaceName: props.projectName, disclosure, organize };
    const dashboard = (area: 'main' | 'aside') => ({ addLabel: t('projects.widgets.add'), addTitle: t('projects.widgets.addTo', {
        dashboard: layout.state.status === 'ready' ? layout.state.dashboard?.name ?? t('projects.pages.overview') : t('projects.pages.overview'),
        area: t(area === 'main' ? 'projects.widgets.mainArea' : 'projects.widgets.sideArea'),
    }), emptyTitle: t('projects.widgets.emptyArea') });
    // One quiet line, only on a shared dashboard: its admitted name and this viewer's access.
    const dashboardFacts = layout.state.status === 'ready' && layout.state.isShared ? layout.state.dashboard ?? null : null;
    const dashboardOwner = useProjectDashboardOwner(layout.state.status === 'ready' ? layout.state.surface.serverId : '',
        dashboardFacts?.ownerAccountId ?? null);
    const identity = dashboardFacts
        ? <ProjectDashboardIdentityLine owner={dashboardOwner ?? { accountId: dashboardFacts.ownerAccountId }} title={dashboardFacts.name}
            detail={t(dashboardFacts.access === 'view' ? 'shareSheet.documents.levels.canRead' : 'shareSheet.documents.levels.canEdit')} />
        // An edited preset says so once, with Reset to preset (lab wgsaved R).
        : preset?.isEdited && presetSurface ? <WidgetAreaPresetLine preset={preset} surface={presetSurface} testID="project-overview.preset" /> : null;
    // Side by side, each area's quiet "Add widget" ends its own column. Stacked (and on a phone) the areas
    // read as one column, so it ends with one "Add widget" (lab HOMEp) whose gallery offers both areas
    // (plan 12 §§2,5: each area stays directly reachable), starting with the main area.
    const stacked = phone || arrangement !== 'columns';
    const areaChoice = (['main', 'aside'] as const).map((area) => ({ area, title: dashboard(area).addTitle,
        label: t(area === 'main' ? 'projects.widgets.mainAreaChoice' : 'projects.widgets.sideAreaChoice') }));
    const trailingAdd = <WidgetArea {...shared} layout={projections.main} area="main" display="add"
        dashboard={{ ...dashboard('main'), areaChoice }} testID="project-overview-main" />;
    return <ProjectOverviewLayout bar={props.bar ?? null} identity={identity} onArrangementChange={setArrangement}
        // While the document first reads, the body is reserved under the bar with nothing that leaves on
        // arrival (no area heading or disabled +): the dashboard words keep the area's own header away.
        blocking={!areas || !merged ? <WidgetArea {...shared} layout={layout} dashboard={dashboard('main')} testID="project-overview-state" /> : undefined}
        main={areas ? <>
            <WidgetArea {...shared} layout={projections.main} area="main" {...(stacked ? { display: 'widgets' as const } : {})}
                dashboard={dashboard('main')} testID="project-overview-main" />
            {stacked ? trailingAdd : null}
        </> : null}
        aside={areas ? <WidgetArea {...shared} layout={projections.aside} area="aside" {...(stacked ? { display: 'widgets' as const } : {})}
            columnLayout={{ columns: arrangement === 'pairs' ? 2 : 1, gap: PROJECT_OVERVIEW_AREA_GAP_PX }}
            dashboard={dashboard('aside')} testID="project-overview-aside" /> : null}
        phone={phone && areas && merged ? <>
            <WidgetArea {...shared} layout={projections.phone} display="widgets" dashboard={dashboard('main')} testID="project-overview-merged" />
            {trailingAdd}
        </> : undefined} />;
}
