import {
    PluginUiDestinationPlacementV1Schema,
    PluginUiDestinationRankHintV1Schema,
    PluginUiToneV1Schema,
    type PluginUiDestinationPlacementV1,
    type PluginUiToneV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    resolvePluginUiIconName,
    type PluginUiIconDirection,
} from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { resolvePluginDisplayString } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { canRenderPluginUiProjectionEntry, type PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type {
    PluginUiDestinationProjection,
    PluginUiPhysicalSurfacePlacementProjection,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { IconName } from '@/components/ui/icons/Icon';

/**
 * The projected-placement -> qualified selectable-destination core.
 *
 * A "destination" is a projected surface placement a user can SELECT: a
 * right-sidebar tab, a full-page plugin destination (`app.page`). Every family
 * of them needs the same six decisions — qualified identity, dedupe, label,
 * icon, deterministic ordering and availability/policy -> `disabledReason` —
 * and they were previously proven exactly once, inside the right-sidebar tab
 * catalog. EU-5b needs the same six for pages, so they live here and both
 * families consume them (§8.1 covers host-side projection consumers, not only
 * contribution registries).
 *
 * The per-family hooks correspond to real, documented differences and nothing
 * else: right-sidebar tabs take their slug from `rightSidebar.tabId` while a
 * page's slug is its contribution id, and right-sidebar tabs carry a
 * per-contribution `disabledPolicy` while a page is always listed and disabled
 * so the user can see why it is unreachable. Neither family reserves raw slugs
 * (UI-D25): every destination id is qualified under its plugin id here, so a
 * slug spelled like a host-owned id cannot collide with one.
 */

type UnknownRecord = Readonly<Record<string, unknown>>;

export type PluginSurfaceDestinationBadge = Readonly<{
    label: string;
    tone: PluginUiToneV1;
}>;

export type PluginSurfaceDestination = Readonly<{
    /** Qualified selection id. Never a raw slug — two plugins may share one. */
    id: `plugin:${string}`;
    pluginId: string;
    /** The declaring contribution's local id. */
    descriptorId: string;
    label: string;
    icon: IconName;
    /** Static author metadata after safe display resolution; never dynamic badge state. */
    badge?: PluginSurfaceDestinationBadge;
    /**
     * Where the author asked the shell to list it: the rail, or a named column. The host catalog
     * resolves it against the columns it has; absent means the rail.
     */
    requestedPlacement?: PluginUiDestinationPlacementV1;
    /** A bounded author rank hint for a host-owned destination catalog. */
    rankHint?: number;
    order: number;
    /**
     * Why the destination cannot be entered right now, or `null`. A reason is
     * shown, never swallowed: a page that vanished silently is indistinguishable
     * from one a plugin never declared.
     */
    disabledReason: string | null;
    placement: PluginUiSurfacePlacementProjection;
}>;

export type PluginSurfaceDestinationSelection = Readonly<{
    /** The family-local slug the qualified id is built from. */
    slug: string;
    /** Explicit host-owned ordering for this destination family. */
    order?: number;
}>;

export type ResolvePluginSurfaceDestinationsInput = Readonly<{
    placements?: readonly PluginUiSurfacePlacementProjection[];
    /** The family's identity + inclusion rule. `null` excludes the placement. */
    select: (placement: PluginUiSurfacePlacementProjection) => PluginSurfaceDestinationSelection | null;
    policyContext?: PluginUiPolicyEvaluationContext;
    /** Whether this family omits a disabled destination instead of showing it. */
    hideWhenDisabled?: (
        placement: PluginUiSurfacePlacementProjection,
        disabledReason: string,
    ) => boolean;
    /** Projection-bound resolver for declared external-plugin localization. */
    localize?: PluginLocalizedTextResolver;
    /** Current app direction for logical display tokens. */
    direction?: PluginUiIconDirection;
}>;

export function readPluginSurfaceRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

export function readPluginSurfaceString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The one qualified destination-id builder. A slug is plugin-local, so the
 * plugin id is always part of the identity — this is why two plugins declaring
 * the same local id can never select each other's destination.
 */
export function buildPluginSurfaceDestinationId(
    pluginId: string,
    slug: string,
): `plugin:${string}` {
    return `plugin:${pluginId}:${slug}`;
}

/** Empty, whitespace or missing slugs collapse to a stable placeholder. */
export function normalizePluginSurfaceDestinationSlug(value: string): string {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : 'surface';
}

/**
 * The one projected-placement display label.
 *
 * It reads only fields every physical placement carries, so an embedded inline
 * surface (a Session widget) names itself through exactly the same authored
 * literal/key/developer-fallback precedence as a navigable destination. A second
 * label resolver for inline roles would let the same contribution be called two
 * different things in the picker and in its mounted frame.
 */
export function resolvePluginSurfaceDestinationLabel(
    placement: PluginUiPhysicalSurfacePlacementProjection,
    localize?: PluginLocalizedTextResolver,
): string {
    // `labelKey`/`titleKey` are translation KEYS, `label`/`title` are authored
    // literals, and the contribution id is the last-resort fallback so an
    // unresolved key never renders raw.
    return resolvePluginDisplayString({
        developerFallback: placement.display.developerFallback,
        literals: [placement.display.label, placement.display.title],
        keys: [placement.display.labelKey, placement.display.titleKey],
        ...(localize === undefined
            ? {}
            : {
                resolveKey: (key: string) => localize(placement.pluginId, {
                    key,
                    fallback: readPluginSurfaceString(placement.display.developerFallback) ?? placement.descriptorId,
                }),
            }),
        fallback: placement.descriptorId,
    }) ?? placement.descriptorId;
}

export function resolvePluginSurfaceDestinationIcon(
    placement: PluginUiPhysicalSurfacePlacementProjection,
    direction?: PluginUiIconDirection,
): IconName {
    const token = readPluginSurfaceString(placement.display.iconToken)
        ?? readPluginSurfaceString(placement.display.icon);
    return resolvePluginUiIconName(token, direction);
}

/** Resolve one static badge without ever rendering an unresolved projection key. */
export function resolvePluginSurfaceDestinationBadge(
    placement: PluginUiSurfacePlacementProjection,
    localize?: PluginLocalizedTextResolver,
): PluginSurfaceDestinationBadge | null {
    const badge = readPluginSurfaceRecord(placement.display.badge);
    if (!badge) {
        return null;
    }
    const label = resolvePluginDisplayString({
        developerFallback: badge.developerFallback,
        literals: [badge.label],
        keys: [badge.labelKey],
        ...(localize === undefined
            ? {}
            : {
                resolveKey: (key: string) => localize(placement.pluginId, {
                    key,
                    fallback: readPluginSurfaceString(badge.developerFallback) ?? '',
                }),
            }),
    });
    if (!label) {
        return null;
    }
    const tone = PluginUiToneV1Schema.safeParse(badge.tone);
    return Object.freeze({
        label,
        tone: tone.success ? tone.data : 'neutral',
    });
}

export function resolvePluginSurfaceDestinationPlacement(
    placement: PluginUiSurfacePlacementProjection,
): PluginUiDestinationPlacementV1 | undefined {
    const requested = PluginUiDestinationPlacementV1Schema.safeParse(placement.display.placement);
    return requested.success ? requested.data : undefined;
}

export function resolvePluginSurfaceDestinationRankHint(
    placement: PluginUiSurfacePlacementProjection,
): number | undefined {
    const rankHint = PluginUiDestinationRankHintV1Schema.safeParse(placement.display.rankHint);
    return rankHint.success ? rankHint.data : undefined;
}

/**
 * Availability and policy -> a reason, in that order. An unavailable placement
 * reports the projection's own reason rather than a host-invented one, and a
 * placement the policy defers is disabled rather than silently interactive.
 */
export function resolvePluginSurfaceDestinationDisabledReason(
    placement: PluginUiDestinationProjection,
    policyContext: PluginUiPolicyEvaluationContext | undefined,
): string | null {
    // Resolving execution does not deny navigation to the declared page. Its
    // route owns loading while Administration resolves the exact origin.
    if (placement.availability.state !== 'available' && placement.availability.state !== 'resolving') {
        return placement.availability.reason;
    }
    if (!canRenderPluginUiProjectionEntry(placement, policyContext)) {
        return 'policy_deferred';
    }
    return null;
}

/**
 * Deterministic host order: an admitted family may supply a host-owned rank;
 * otherwise qualified identity is the stable tie-breaker after the final
 * default rank. Projection rows carry no contributor ordering authority; a
 * normalized author rank is only carried to a host-owned catalog as a hint.
 */
export function comparePluginSurfaceDestinations(
    left: Readonly<{ order: number; id: string }>,
    right: Readonly<{ order: number; id: string }>,
): number {
    return left.order - right.order || left.id.localeCompare(right.id);
}

export function resolvePluginSurfaceDestinations(
    input: ResolvePluginSurfaceDestinationsInput,
): readonly PluginSurfaceDestination[] {
    const destinations: PluginSurfaceDestination[] = [];
    // A qualified destination is a single public identity. Host order is
    // allowed to decide presentation order among distinct destinations, never
    // which of two conflicting declarations becomes authoritative. Record every
    // selected identity before availability filtering so a temporarily hidden
    // duplicate cannot later surface as the owner when its policy changes.
    const claimedIds = new Set<string>();
    const duplicateIds = new Set<string>();

    for (const placement of input.placements ?? []) {
        const selection = input.select(placement);
        if (!selection) {
            continue;
        }
        const slug = normalizePluginSurfaceDestinationSlug(selection.slug);
        const id = buildPluginSurfaceDestinationId(placement.pluginId, slug);
        if (claimedIds.has(id)) {
            duplicateIds.add(id);
        } else {
            claimedIds.add(id);
        }
        const disabledReason = resolvePluginSurfaceDestinationDisabledReason(
            placement,
            input.policyContext,
        );
        if (disabledReason !== null && input.hideWhenDisabled?.(placement, disabledReason) === true) {
            continue;
        }
        const badge = resolvePluginSurfaceDestinationBadge(placement, input.localize);
        const requestedPlacement = resolvePluginSurfaceDestinationPlacement(placement);
        const rankHint = resolvePluginSurfaceDestinationRankHint(placement);
        destinations.push(Object.freeze({
            id,
            pluginId: placement.pluginId,
            descriptorId: placement.descriptorId,
            label: resolvePluginSurfaceDestinationLabel(placement, input.localize),
            icon: resolvePluginSurfaceDestinationIcon(placement, input.direction),
            ...(badge === null ? {} : { badge }),
            ...(requestedPlacement === undefined ? {} : { requestedPlacement }),
            ...(rankHint === undefined ? {} : { rankHint }),
            order: selection.order ?? Number.MAX_SAFE_INTEGER,
            disabledReason,
            placement,
        }));
    }

    return Object.freeze(destinations
        .filter((destination) => !duplicateIds.has(destination.id))
        .sort(comparePluginSurfaceDestinations));
}
