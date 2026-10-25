import type { PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

type SelectionInput = Readonly<{
    pluginProjectionById?: Readonly<Record<string, PluginProjectionEntry>> | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    targetedContributions?: PluginUiTargetedContributionsV1 | null;
    targetPluginId?: string | null;
}>;

function selectTarget(input: SelectionInput): PluginUiTargetedContributionsV1 | null {
    return typeof input.targetPluginId === 'string' && input.targetPluginId.length > 0
        && input.targetedContributions?.target.pluginId === input.targetPluginId
        ? input.targetedContributions
        : null;
}

function selectPluginIds(target: PluginUiTargetedContributionsV1 | null): readonly string[] {
    const selectedPluginIds = new Set<string>();
    for (const point of target?.points ?? []) {
        for (const protocol of point.protocols) {
            for (const contribution of protocol.contributions) {
                for (const operation of contribution.operations) selectedPluginIds.add(operation.action.pluginId);
            }
        }
    }
    return [...selectedPluginIds].sort();
}

/** Exact target-scoped Action facts, shared by publication and live requests. */
export function projectPluginActionInputSelectionFacts(input: SelectionInput): Readonly<{
    targetedContributions: PluginUiTargetedContributionsV1 | null;
    hasPluginProjection: boolean;
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginUiProjection: PluginUiProjectionModel | null;
}> {
    const targetedContributions = selectTarget(input);
    const pluginProjectionById: Record<string, PluginProjectionEntry> = {};
    for (const pluginId of selectPluginIds(targetedContributions)) {
        const plugin = input.pluginProjectionById?.[pluginId];
        if (plugin) pluginProjectionById[pluginId] = plugin;
    }
    return Object.freeze({
        targetedContributions,
        hasPluginProjection: input.pluginProjectionById !== undefined && input.pluginProjectionById !== null,
        pluginProjectionById: Object.freeze(pluginProjectionById),
        pluginUiProjection: input.pluginUiProjection ?? null,
    });
}

export type PluginActionInputSelectionFactsInput = Omit<SelectionInput, 'pluginUiProjection'> & Readonly<{
    translationsByPluginId?: PluginUiProjectionModel['translationsByPluginId'] | null;
}>;

/** Controller dependencies only; this is never an invocation/admission result. */
export type PluginActionInputSelectionSnapshot = Readonly<{
    hasPluginProjection: boolean;
    hasTargetedContributions: boolean;
    /** Empty targets have no selectable operation; their scope stays mount-owned. */
    targetedContributions: PluginUiTargetedContributionsV1 | null;
    selected: readonly Readonly<{
        pluginId: string;
        plugin: PluginProjectionEntry | null;
        hasTranslations: boolean;
        bundles: PluginUiProjectionModel['translationsByPluginId'][string]['bundles'] | null;
    }>[];
}>;

type SelectionPresence = Readonly<{ hasPluginProjection: boolean; hasTargetedContributions: boolean }>;
const EMPTY_SELECTED_INPUTS: PluginActionInputSelectionSnapshot['selected'] = Object.freeze([]);
function presenceSnapshot(hasPluginProjection: boolean, hasTargetedContributions: boolean): PluginActionInputSelectionSnapshot {
    return Object.freeze({ hasPluginProjection, hasTargetedContributions,
        targetedContributions: null, selected: EMPTY_SELECTED_INPUTS });
}
const EMPTY_SELECTION_SNAPSHOTS = [
    presenceSnapshot(false, false), presenceSnapshot(false, true),
    presenceSnapshot(true, false), presenceSnapshot(true, true),
] as const;

/** No-operation facts have no target/custody data or retained authority. */
export function readPluginActionInputSelectionPresenceSnapshot(input: SelectionPresence): PluginActionInputSelectionSnapshot {
    return EMPTY_SELECTION_SNAPSHOTS[(input.hasPluginProjection ? 2 : 0) + (input.hasTargetedContributions ? 1 : 0)]!;
}

function ownNativeInput<T>(input: T): T {
    // These schema-shaped native inputs are copied by the canonical JSON owner;
    // only its private deep-immutable proof permits an O(1) subsequent read.
    return projectNativeJsonValueForTransport(input) as unknown as T;
}

function shareEqualInput<T>(input: T, previous: T | undefined): T {
    return previous !== undefined && sameStrictJsonValue(input, previous) ? previous : input;
}

/** One current selected snapshot, published by the existing mounted source. */
export function createPluginActionInputSelectionFactsPublication(): Readonly<{
    publish(input: PluginActionInputSelectionFactsInput): PluginActionInputSelectionSnapshot;
    /** Source-declared no-operation path; never substitutes for target admission. */
    publishEmpty(input: SelectionPresence): PluginActionInputSelectionSnapshot;
}> {
    let previous: PluginActionInputSelectionSnapshot | null = null;
    let acquiredTarget: PluginUiTargetedContributionsV1 | null = null;
    let selectedPluginIds: readonly string[] = [];
    const publishEmpty = (input: SelectionPresence) => {
        acquiredTarget = null;
        selectedPluginIds = [];
        previous = readPluginActionInputSelectionPresenceSnapshot(input);
        return previous;
    };
    return Object.freeze({
        publishEmpty,
        publish(input) {
            const rawTarget = selectTarget(input);
            const hasPluginProjection = input.pluginProjectionById !== undefined && input.pluginProjectionById !== null;
            const hasTargetedContributions = rawTarget !== null;
            // No operation can be admitted from an empty target. Keep presence
            // (host-unavailable vs action-not-found), not synthetic custody keys.
            if (!hasPluginProjection || !rawTarget || rawTarget.points.length === 0) {
                return publishEmpty({ hasPluginProjection, hasTargetedContributions });
            }
            const target = shareEqualInput(ownNativeInput(rawTarget), acquiredTarget);
            const pluginIds = target === acquiredTarget ? selectedPluginIds : selectPluginIds(target);
            const selected = pluginIds.map((pluginId, index) => {
                const old = previous?.selected[index]?.pluginId === pluginId ? previous.selected[index] : undefined;
                const rawPlugin = input.pluginProjectionById?.[pluginId];
                const plugin = rawPlugin ? shareEqualInput(ownNativeInput(rawPlugin), old?.plugin) : null;
                const translations = plugin ? input.translationsByPluginId?.[pluginId] : undefined;
                const rawBundles = translations?.bundles;
                const bundles = rawBundles === undefined ? null : shareEqualInput(ownNativeInput(rawBundles), old?.bundles);
                return Object.freeze({ pluginId, plugin, hasTranslations: Boolean(translations), bundles });
            });
            const selectionTarget = pluginIds.length > 0 ? target : null;
            if (previous && previous.hasPluginProjection === hasPluginProjection
                && previous.hasTargetedContributions === hasTargetedContributions
                && previous.targetedContributions === selectionTarget
                && previous.selected.length === selected.length
                && previous.selected.every((old, index) => old.pluginId === selected[index]?.pluginId
                    && old.plugin === selected[index]?.plugin && old.hasTranslations === selected[index]?.hasTranslations
                    && old.bundles === selected[index]?.bundles)) {
                acquiredTarget = target;
                selectedPluginIds = pluginIds;
                return previous;
            }
            previous = Object.freeze({ hasPluginProjection, hasTargetedContributions,
                targetedContributions: selectionTarget, selected: Object.freeze(selected) });
            acquiredTarget = target;
            selectedPluginIds = pluginIds;
            return previous;
        },
    });
}

