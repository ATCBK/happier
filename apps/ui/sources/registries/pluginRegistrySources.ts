import { createPluginRegistrySourceDescriptorV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionSupplies } from '@/sync/domains/plugins/ui/projectionUnion';

/** Preserve every proven supplier, including its retained offline declaration. */
export function projectPluginRegistrySources(projection: PluginUiProjectionModel | null): readonly RegistrySourceDescriptorV1[] {
    return Object.values(projection?.registrySourcesById ?? {}).map(entry => createPluginRegistrySourceDescriptorV1({
        pluginId: entry.pluginId, definition: entry.definition,
        suppliers: readPluginUiContributionSupplies(entry).map(supply => supply.machineId),
    }));
}
