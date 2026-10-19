import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { t } from '@/text';
import { resolveSessionScmReviewComparisonLabel } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

/**
 * Who a Session widget says it comes from.
 *
 * A durable Board item outlives the plugin generation that renders it, so the
 * name people read must stay truthful in every state — mounted, loading,
 * updating and unavailable. Collapsing every installed source to “From a plugin”
 * is the failure this owner exists to prevent: with two review widgets on one
 * Board, that label makes the disabled one indistinguishable from the working
 * one and makes "Manage plugin" a guess.
 *
 * The line says whose a widget is, never which: the item's own title already says that, so the
 * contribution name is not repeated here ("Directory count · Directory count · Widget areas").
 *
 * Provenance is presentation only. It never becomes an authority, currentness or
 * availability input, and it never replaces the item's own user-owned title.
 */

export type BoardWidgetProvenance = Readonly<{
    /** The quiet secondary line under the widget title. */
    label: string;
    /**
     * The accessible label, which always retains the exact qualified identity
     * when two installed plugins present the same display name.
     */
    accessibilityLabel: string;
}>;

function provenance(label: string, accessibilityLabel?: string): BoardWidgetProvenance {
    return Object.freeze({ label, accessibilityLabel: accessibilityLabel ?? label });
}

/**
 * Resolve one item's provenance line from the exact current Session projection.
 *
 * `projection` is `null` whenever the host has no plugin runtime yet. An
 * installed widget then keeps a truthful generic line rather than inventing a
 * plugin name from its stored identity.
 */
export function resolveBoardWidgetProvenance(
    source: SessionSurfaceItemV1['source'],
    projection: PluginUiProjectionModel | null | undefined,
    options?: Readonly<{
        snapshot?: boolean | SessionSurfaceItemV1['snapshot'];
        viewerAccountId?: string | null;
        posterDisplayName?: string | null;
    }>,
): BoardWidgetProvenance {
    // A posted snapshot is frozen declarative content; it reads as what it is, not as a note.
    if (options?.snapshot) {
        const poster = typeof options.snapshot === 'object' ? options.snapshot.postedByAccountId : undefined;
        if (poster && poster === options.viewerAccountId) return provenance(t('sessionBoard.item.provenance.snapshotByYou'));
        if (poster && options.posterDisplayName) return provenance(t('sessionBoard.item.provenance.snapshotBy', { name: options.posterDisplayName }));
        return provenance(t('sessionBoard.item.provenance.snapshot'));
    }
    if (source.kind === 'declarative') {
        // An agent visual says what it is: a chart or a table, never "Note" for every document.
        const root = (source.document as { root?: { kind?: unknown } } | undefined)?.root?.kind;
        return provenance(root === 'chart' ? t('sessionBoard.item.provenance.chart')
            : root === 'table' ? t('sessionBoard.item.provenance.table')
                : t('sessionBoard.item.provenance.note'));
    }
    if (source.kind === 'walkthrough') return provenance(resolveSessionScmReviewComparisonLabel({ kind: source.comparison }));
    if (source.kind !== 'widget' || source.instance.definition.kind !== 'installed') {
        return provenance(t('sessionBoard.item.provenance.interactiveView'));
    }

    const surface = source.instance.definition.surface;
    const installed = projection?.installedPackagesById[surface.pluginId] ?? null;
    const pluginName = installed?.displayName.trim();
    if (!pluginName) {
        // The plugin is not installed on this device (or not yet projected).
        // Naming its id is more useful than "a plugin", and it is exactly what
        // the person needs to find it in Manage plugins.
        return provenance(t('sessionBoard.item.provenance.pluginMissing', {
            pluginId: surface.pluginId,
        }));
    }

    // Two installed plugins may legitimately share a display name. Assistive
    // technology keeps the qualified plugin id so they stay distinguishable.
    const duplicateDisplayName = Object.entries(projection?.installedPackagesById ?? {}).some((
        [pluginId, entry],
    ) => pluginId !== surface.pluginId && entry.displayName.trim() === pluginName);
    return provenance(
        pluginName,
        duplicateDisplayName
            ? t('sessionBoard.item.provenance.pluginQualified', { label: pluginName, pluginId: surface.pluginId })
            : pluginName,
    );
}
