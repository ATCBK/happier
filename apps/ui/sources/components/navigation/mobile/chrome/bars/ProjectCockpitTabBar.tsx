import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { Icon } from '@/components/ui/icons/Icon';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveFloatingTabBarSlotCount } from '@/components/ui/navigation/FloatingTabBarSurface';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { NavigationPlacementPinButton } from '@/components/ui/navigation/NavigationPlacementPinButton';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { resolveNavigationOverflow, resolveNavigationPlacements } from '@/sync/domains/settings/mobileSurfacePinning';
import { useSetting } from '@/sync/domains/state/storage';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { normalizeProjectMobileSurface, normalizeProjectPage, type ProjectMobileSurface, type ProjectPageV1 } from '@/components/workspaceCockpit/project/projectCockpitState';
import { getRightSidebarTabLabel, resolveProjectRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { resolveRightSidebarMobileProjection, resolveRightSidebarMobileSurface } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import type { ProjectPageDescriptor } from '@/components/projects/detail/projectPageCatalog';
import { ProjectPageChromeCounts, type ProjectPageChromeDescriptor } from '@/components/projects/navigation/ProjectPageChromeCounts';
import type { ProjectPageCatalogModel } from '@/components/projects/navigation/useProjectPageCatalog';
import type { NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { Modal } from '@/modal';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { CockpitTabBar, CockpitTabBarAction, type CockpitTabBarTabDefinition } from './CockpitTabBar';
import { sfSymbolForCockpitTabIcon } from './cockpitTabSymbols';

export type ProjectNavigationPage = Pick<ProjectPageChromeDescriptor, 'id' | 'title' | 'icon' | 'disabledReason' | 'disabledReasonCode' | 'allowedPlacements' | 'count' | 'counts'>;
export type ProjectCockpitTabBarProps = Readonly<{
    workspaceRefId: string;
    pages: readonly ProjectPageDescriptor[];
    countScope?: Pick<ProjectPageCatalogModel, 'context' | 'projection' | 'authority'>;
    activeSurface: ProjectMobileSurface;
    activePage?: ProjectPageV1;
    activePageId?: string;
    terminalTabAvailable?: boolean;
    onPagePress?: (id: string) => void;
    onSurfacePress: (surface: ProjectMobileSurface) => void;
}>;

/** The catalog supplies pages; existing placement and fit owners decide the phone's prefix. */
export const ProjectCockpitTabBar = React.memo((props: ProjectCockpitTabBarProps) => {
    const { preferences } = useNavigationSurfacePlacement('projectTabBar');
    return props.countScope ? <ProjectPageChromeCounts {...props.countScope} pages={props.pages} preferences={preferences}>
        {pages => <ProjectCockpitTabBarContent {...props} pages={pages} preferences={preferences} />}
    </ProjectPageChromeCounts> : <ProjectCockpitTabBarContent {...props} preferences={preferences} />;
});

export type ProjectCockpitTabDefinition = CockpitTabBarTabDefinition<string> & Readonly<{ sfSymbol: string }>;

/** Descriptors and navigation stay identical across the RN and native presenters. */
export function useProjectCockpitTabDefinitions(props: Omit<ProjectCockpitTabBarProps, 'pages'> & Readonly<{
    pages: readonly ProjectNavigationPage[];
}>) {
    const pagesById = React.useMemo(() => new Map(props.pages.map(page => [page.id, page])), [props.pages]);
    const registry = resolveProjectRightSidebarTabs({ presentation: 'mobile',
        activePage: props.activePage ?? normalizeProjectPage(props.activeSurface) ?? 'overview',
        terminalTabAvailable: props.terminalTabAvailable === true });
    const companions: readonly ProjectNavigationPage[] = [
        ...resolveRightSidebarMobileProjection({ scope: 'project', tabs: registry }).flatMap(entry => {
            const surface = normalizeProjectMobileSurface(entry.surface);
            if (!surface || normalizeProjectPage(surface)) return [];
            return [{ id: surface, title: getRightSidebarTabLabel(entry.tab), icon: entry.tab.icon, disabledReason: null }];
        }),
        { id: 'tabs', title: t('phoneNav.bar.openFiles'), icon: 'files', disabledReason: null },
    ];
    const activeId = normalizeProjectPage(props.activeSurface) ? props.activePageId ?? props.activeSurface : props.activeSurface;
    const tabForPage = (page: ProjectNavigationPage): ProjectCockpitTabDefinition => ({
        id: page.id, label: page.count ? `${page.title} ${page.count}` : page.title, icon: page.icon,
        sfSymbol: sfSymbolForCockpitTabIcon(page.icon),
        accessibilityLabel: page.count ? `${page.title}, ${page.count}` : page.title, disabled: page.disabledReason !== null,
        unavailableReason: page.disabledReason ? page.disabledReasonCode ? page.disabledReason
            : resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: page.disabledReason }).body : undefined,
    });
    const select = (id: string) => {
        const page = pagesById.get(id);
        if (page) {
            if (page.disabledReason) return;
            if (props.onPagePress) props.onPagePress(id);
            else {
                const builtin = normalizeProjectPage(id);
                if (builtin) props.onSurfacePress(builtin);
            }
        } else {
            const surface = normalizeProjectMobileSurface(id);
            if (surface) props.onSurfacePress(surface);
        }
    };
    return { companions, pagesById, registry, activeId, tabForPage, select };
}

function ProjectCockpitTabBarContent(props: Omit<ProjectCockpitTabBarProps, 'pages'> & Readonly<{
    pages: readonly ProjectNavigationPage[];
    preferences: NavigationPlacementPreferences;
}>) {
    const [moreOpen, setMoreOpen] = React.useState(false);
    const { preferences } = props;
    const windowWidth = useWindowDimensions().width;
    const tabMinWidth = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels')).tabMinWidth;
    const slotCount = resolveFloatingTabBarSlotCount({ windowWidth, maxWidth: layout.maxWidth, tabMinWidth });
    const placements = React.useMemo(() => resolveNavigationPlacements(props.pages, preferences), [props.pages, preferences]);
    const { companions, pagesById, registry, activeId, tabForPage, select } = useProjectCockpitTabDefinitions(props);
    const fit = resolveNavigationOverflow(placements.pinned, [...placements.overflow, ...companions],
        { availableSize: slotCount, itemSize: 1 });
    const overflowIds = new Set(fit.overflow.map(page => page.id));
    const behindMore = [...placements.ordered.filter(page => overflowIds.has(page.id)), ...companions];
    const activeBehindMore = fit.shown.some(page => page.id === activeId) ? null
        : [...props.pages, ...companions].find(page => page.id === activeId) ?? null;
    const retainedTab = !normalizeProjectPage(props.activeSurface) ? registry.find(tab =>
        resolveRightSidebarMobileSurface(tab, 'project') === props.activeSurface) : undefined;
    const activeMore = activeBehindMore ?? (retainedTab ? { title: getRightSidebarTabLabel(retainedTab), icon: retainedTab.icon } : null);
    const tabs = fit.shown.map(tabForPage);
    const customize = () => {
        setMoreOpen(false);
        fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ NavigationPlacementCustomizer }) => {
            Modal.show({ component: NavigationPlacementCustomizer, props: { surfaceId: 'projectTabBar',
                items: props.pages, testID: 'project-tabs-customizer' } });
        }), { tag: 'ProjectCockpitTabBar.customize' });
    };
    const items: readonly DropdownMenuItem[] = [...behindMore.map(entry => {
        const page = pagesById.get(entry.id);
        const pinned = placements.effectivePlacements[entry.id] === 'pinned';
        return { id: entry.id, title: entry.title, icon: <Icon name={entry.icon} size={18} />,
            category: page ? 'pages' : 'companions', checked: entry.id === activeId,
            disabled: entry.disabledReason !== null,
            subtitle: entry.disabledReason ? entry.disabledReasonCode ? entry.disabledReason
                : resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: entry.disabledReason }).body : entry.count,
            testID: `project-cockpit-more-item:${entry.id}`,
            rightElement: moreOpen && page && (page.allowedPlacements === undefined || page.allowedPlacements.includes(pinned ? 'overflow' : 'pinned'))
                ? <NavigationPlacementPinButton surfaceId="projectTabBar" entryId={entry.id} pinned={pinned}
                    label={t(pinned ? 'phoneNav.bar.removeFromBar' : 'phoneNav.bar.keepOnBar')} preferences={preferences}
                    testID={`project-cockpit-pin:${entry.id}`} /> : undefined,
        };
    }), { id: 'customize', title: t('navigationPlacement.customize'), icon: <Icon name="sliders-horizontal" size={18} />,
        testID: 'project-cockpit-more-customize' }];

    return <CockpitTabBar activeSurface={activeId} barTestId={`project-cockpit-tabbar-${props.workspaceRefId}`}
        tabs={tabs} tabTestIdPrefix="project-cockpit-tab-" layout="fit" onSurfacePress={select}
        trailing={<DropdownMenu open={moreOpen} onOpenChange={setMoreOpen} items={items}
            selectedId={activeBehindMore?.id ?? null} onSelect={id => {
                if (id === 'customize') { customize(); return; }
                setMoreOpen(false); select(id);
            }} matchTriggerWidth={false} placement="top" trigger={({ open, toggle }) =>
                <CockpitTabBarAction testID="project-cockpit-tab-more" label={activeBehindMore?.count
                    ? `${activeBehindMore.title}, ${activeBehindMore.count}` : activeMore?.title ?? t('common.more')}
                    icon={activeMore?.icon ?? 'dots-three'} selected={activeMore !== null} expanded={open} onPress={toggle} />}
        />} />;
}
