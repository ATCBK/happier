import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';
import type { IconName } from '@/components/ui/icons/Icon';
import { resolvePluginPages, type PluginPage, type PluginPageTarget } from '@/components/plugins/pages/pluginPages';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { PROJECT_PAGES, type ProjectPageSelection, resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { projectPageGlyph, projectPageLabel } from '@/components/projects/navigation/projectPageDisplay';
import type { NavigationPlacement } from '@/sync/domains/settings/mobileSurfacePinning';

const OVERVIEW_PLACEMENTS: readonly NavigationPlacement[] = Object.freeze(['pinned']);

/** The descriptive Project catalog; renderer activation and invocation admission stay with their owners. */
export type ProjectPageDescriptor = Readonly<{
    id: string;
    title: string;
    icon: IconName;
    href: string;
    kind: 'builtin' | 'plugin';
    disabledReason: string | null;
    /** Canonical diagnostic when the disabled reason is authored human wording. */
    disabledReasonCode?: string;
    visible: boolean;
    destination?: PluginUiDestinationReferenceV1;
    selection: ProjectPageSelection;
    /** The admitted shared descriptor, retained for the body and catalog baseline. */
    pluginPage?: PluginPage;
    allowedPlacements?: readonly NavigationPlacement[];
}>;

type ProjectPageCatalogInput = Readonly<{
    target: Extract<PluginPageTarget, { kind: 'project' }>;
    placements?: readonly PluginUiSurfacePlacementProjection[];
    policyContext?: PluginUiPolicyEvaluationContext;
    localize?: PluginLocalizedTextResolver;
}>;
export type ProjectPageCatalogState = Readonly<{
    pages: readonly ProjectPageDescriptor[];
    routePages: readonly ProjectPageDescriptor[];
}>;

/** One policy/catalog pass supplies descriptive navigation and exact-route refusal. */
export function resolveProjectPageCatalogState(input: ProjectPageCatalogInput & Readonly<{
    baseline?: ProjectPageCatalogState;
}>): ProjectPageCatalogState {
    const previous = new Map(input.baseline?.routePages.map(page => [page.id, page]));
    const pluginPages = resolvePluginPages({ target: input.target, placements: input.placements,
        policyContext: input.policyContext, localize: input.localize,
        baseline: input.baseline?.routePages.flatMap(page => page.pluginPage ? [page.pluginPage] : []) });
    const pages: ProjectPageDescriptor[] = PROJECT_PAGES.map(page => {
        const title = projectPageLabel(page);
        const icon = projectPageGlyph(page);
        const href = resolveProjectRoutePathForSurface({ ...input.target, surface: page });
        const prior = previous.get(page);
        return prior?.kind === 'builtin' && prior.title === title && prior.icon === icon && prior.href === href ? prior
            : Object.freeze({ id: page, title, icon, href, kind: 'builtin' as const, disabledReason: null, visible: true,
                ...(page === 'overview' ? { allowedPlacements: OVERVIEW_PLACEMENTS } : {}),
                selection: Object.freeze({ kind: 'builtin' as const, page }) });
    });
    for (const page of pluginPages) {
        const prior = previous.get(page.id);
        if (prior?.pluginPage === page) { pages.push(prior); continue; }
        const destination = Object.freeze({ pluginId: page.pluginId, localId: page.localId });
        pages.push(Object.freeze({ id: page.id, title: page.label, icon: page.icon, href: page.routePath,
            kind: 'plugin' as const, disabledReason: page.disabledReason,
            ...(page.disabledReasonCode ? { disabledReasonCode: page.disabledReasonCode } : {}),
            visible: page.visible, destination, pluginPage: page,
            selection: Object.freeze({ kind: 'plugin' as const, destination, subPath: '' }) }));
    }
    const routePages = input.baseline?.routePages.length === pages.length
        && pages.every((page, index) => page === input.baseline?.routePages[index]) ? input.baseline.routePages : Object.freeze(pages);
    const visible = routePages.filter(page => page.visible);
    const visiblePages = input.baseline?.pages.length === visible.length
        && visible.every((page, index) => page === input.baseline?.pages[index]) ? input.baseline.pages : Object.freeze(visible);
    return input.baseline?.routePages === routePages && input.baseline.pages === visiblePages
        ? input.baseline : Object.freeze({ pages: visiblePages, routePages });
}

/** Public descriptive projection; the same state owner also supplies the exact-route body. */
export function resolveProjectPageCatalog(input: ProjectPageCatalogInput & Readonly<{
    baseline?: readonly ProjectPageDescriptor[];
}>): readonly ProjectPageDescriptor[] {
    return resolveProjectPageCatalogState({ ...input, baseline: input.baseline
        ? { pages: input.baseline, routePages: input.baseline } : undefined }).pages;
}
