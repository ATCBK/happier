import { normalizePluginUiDestinationBindingV1, PluginUiDestinationReferenceV1Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';

/** Page chrome fixtures pass through the real public binding admission and shared catalog. */
export function createPluginPagePlacementFixture(input: Readonly<{
    pluginId: string;
    localId: string;
    title: string;
    targetKind?: 'app' | 'project';
    availability?: PluginUiSurfacePlacementProjection['availability'];
}>): PluginUiSurfacePlacementProjection {
    const rendererId = `${input.localId}-renderer`;
    PluginUiDestinationReferenceV1Schema.parse({ pluginId: input.pluginId, localId: input.localId });
    const binding = normalizePluginUiDestinationBindingV1({ pluginId: input.pluginId, destinationId: input.localId,
        rendererId, container: 'appPage', target: { kind: input.targetKind ?? 'project' } });
    if (!binding) throw new Error('Page fixture must use an admitted public destination binding');
    return { id: `page:${input.pluginId}:${input.localId}`, pluginId: input.pluginId, descriptorId: input.localId,
        contributionKind: 'surfacePlacement', binding, target: binding.target,
        renderer: { kind: 'reactNative', contributionId: rendererId }, display: { title: input.title, iconToken: 'play' },
        availability: input.availability ?? { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [] };
}
