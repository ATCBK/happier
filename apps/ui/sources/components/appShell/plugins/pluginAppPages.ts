import {
    normalizePluginUiSubPathV1,
    type PluginUiDestinationReferenceV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    resolvePluginSurfaceDestinations,
    type PluginSurfaceDestination,
} from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import { resolvePluginLocalizedText, type PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type {
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { selectPluginSurfacePlacementsForBinding } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { buildPluginAppPageRoutePath } from './pluginAppPageRoute';
export { buildPluginAppPageRoutePath, PLUGIN_APP_PAGE_ROUTE_PREFIX } from './pluginAppPageRoute';

/**
 * The host-owned plugin page catalog (EU-5b, §3.7).
 *
 * A page is addressed by qualified `{ pluginId, localId }` identity and the HOST
 * generates its route: `/plugins/<pluginId>/<localId>` plus the plugin's own
 * location under it. A plugin never names a route, so two plugins declaring the
 * same local page id cannot collide, and the host keeps authority over its URL
 * space — the reason the retired "plugin registers a route" shape was wrong.
 *
 * Identity, dedupe, label, icon, ordering and availability -> `disabledReason`
 * are the shared destination core the right-sidebar tab catalog also consumes;
 * this module adds only what a page has and a tab does not: the generated route
 * and the sub-path grammar under it.
 */

export const PLUGIN_APP_PAGE_BINDING_SLOT = Object.freeze({
    container: 'appPage' as const,
    targetKind: 'app' as const,
});

export type PluginAppPage = PluginSurfaceDestination & Readonly<{
    /** Declaration-owned purpose, resolved before the executable page loads. */
    description?: string;
    /** `toolbar` when the page draws a Collection toolbar as its own header (its name leads it); else a page header. */
    headerStyle?: 'toolbar';
    /** The page's plugin-local id — the second segment of its generated route. */
    localId: string;
    /** The generated route of the page ROOT (no sub-path). */
    routePath: string;
    /**
     * The page's own shell column, when it declares one and its renderer is available: the same
     * destination and authority, with the producer's column-specific renderer binding and its own
     * mount id so the page and its column are two surfaces.
     */
    columnPlacement?: PluginUiSurfacePlacementProjection;
}>;

function resolvePluginAppPageColumnPlacement(
    placement: PluginUiSurfacePlacementProjection,
): PluginUiSurfacePlacementProjection | undefined {
    const column = placement.column;
    // An unavailable column renderer means no column: the page stands full width.
    if (!column || column.availability.state !== 'available') return undefined;
    return Object.freeze({
        ...placement,
        id: `${placement.id}:column`,
        binding: column.binding,
        renderer: column.renderer,
        // The column shares this page's unresolved producer selection. Its own
        // renderer availability cannot turn that pending selection into a mount.
        availability: placement.availability.state === 'resolving'
            ? placement.availability : column.availability,
    });
}

/** The plugin-local location a pathname under the page's route names, or `null` when it is not under it. */
export function readPluginAppPageSubPathFromPathname(page: PluginAppPage, pathname: string): string | null {
    const trimmed = pathname.replace(/\/+$/, '');
    if (trimmed === page.routePath) return '';
    if (!trimmed.startsWith(`${page.routePath}/`)) return null;
    const segments = trimmed.slice(page.routePath.length + 1).split('/');
    try {
        return readPluginAppPageSubPath(segments.map((segment) => decodeURIComponent(segment)));
    } catch {
        return null;
    }
}

/**
 * Read the plugin-local location out of an Expo Router rest parameter.
 *
 * The router hands the rest segments back already percent-decoded, as either a
 * joined string or a segment array depending on platform and match, so both are
 * accepted and normalized to the one canonical spelling the render context
 * carries. An illegal value is rejected as `null`, so the route owner can show
 * the ordinary unavailable tombstone instead of silently opening page root.
 */
export function readPluginAppPageSubPath(value: string | readonly string[] | undefined): string | null {
    if (value === undefined) return '';
    const joined = Array.isArray(value) ? value.join('/') : String(value);
    return normalizePluginUiSubPathV1(joined);
}

export function selectPluginAppPagePlacements(
    model: PluginUiProjectionModel | null | undefined,
): readonly PluginUiSurfacePlacementProjection[] {
    return model
        ? selectPluginSurfacePlacementsForBinding(model, PLUGIN_APP_PAGE_BINDING_SLOT)
        : [];
}

/**
 * The page catalog.
 *
 * Unlike a right-sidebar tab, an unavailable page is LISTED and disabled rather
 * than hidden: a page is a destination a user navigates to by name, so silently
 * removing it is indistinguishable from a plugin that never declared it. The
 * reason travels with the entry and the route itself degrades to the canonical
 * unavailable surface.
 */
export function resolvePluginAppPages(input: Readonly<{
    placements?: readonly PluginUiSurfacePlacementProjection[];
    policyContext?: PluginUiPolicyEvaluationContext;
    localize?: PluginLocalizedTextResolver;
}>): readonly PluginAppPage[] {
    const destinations = resolvePluginSurfaceDestinations({
        ...(input.placements ? { placements: input.placements } : {}),
        ...(input.policyContext ? { policyContext: input.policyContext } : {}),
        ...(input.localize ? { localize: input.localize } : {}),
        select: (placement) => {
            const binding = placement.binding;
            // The Registry-normalized binding is the public page identity. A
            // descriptor id is renderer metadata, not an alternate route or
            // openSurface selector, and a malformed cross-plugin projection is
            // not admitted locally as a replacement identity.
            if (
                binding.container !== PLUGIN_APP_PAGE_BINDING_SLOT.container
                || binding.targetKind !== PLUGIN_APP_PAGE_BINDING_SLOT.targetKind
                || binding.destination.pluginId !== placement.pluginId
            ) {
                return null;
            }
            return { slug: binding.destination.localId };
        },
    });

    return Object.freeze(destinations.map((destination) => {
        const columnPlacement = resolvePluginAppPageColumnPlacement(destination.placement);
        const declaredDescription = destination.placement.display.description;
        const description = declaredDescription === undefined ? undefined
            : input.localize
                ? input.localize(destination.pluginId, declaredDescription)
                : resolvePluginLocalizedText({ projection: null, pluginId: destination.pluginId, value: declaredDescription });
        return Object.freeze({
            ...destination,
            ...(description === undefined ? {} : { description }),
            ...(destination.placement.display.headerStyle === 'toolbar' ? { headerStyle: 'toolbar' as const } : {}),
            localId: destination.placement.binding.destination.localId,
            routePath: buildPluginAppPageRoutePath({
                pluginId: destination.pluginId,
                localId: destination.placement.binding.destination.localId,
            }),
            ...(columnPlacement ? { columnPlacement } : {}),
        });
    }));
}

/**
 * Resolve the page a generated route names, or `null` — fail closed.
 *
 * Both segments must match: the local id alone is not identity, which is what
 * makes two plugins declaring `notes` structurally unable to reach each other.
 */
export function resolvePluginAppPageForRoute(input: Readonly<{
    pages: readonly PluginAppPage[];
    pluginId: string;
    localId: string;
}>): PluginAppPage | null {
    const pluginId = input.pluginId.trim();
    const localId = input.localId.trim();
    if (pluginId.length === 0 || localId.length === 0) {
        return null;
    }
    return input.pages.find((page) => page.pluginId === pluginId && page.localId === localId) ?? null;
}

/**
 * Resolve the page an exact `openSurface(destination, …)` reference names.
 *
 * The Protocol owns exact qualified identity, so a cross-plugin navigation
 * resolves through this one host catalog without a caller-side fallback.
 * Availability remains the catalog/handler decision.
 */
export function resolvePluginAppPageForReference(input: Readonly<{
    pages: readonly PluginAppPage[];
    destination: PluginUiDestinationReferenceV1;
}>): PluginAppPage | null {
    return resolvePluginAppPageForRoute({
        pages: input.pages,
        pluginId: input.destination.pluginId,
        localId: input.destination.localId,
    });
}
