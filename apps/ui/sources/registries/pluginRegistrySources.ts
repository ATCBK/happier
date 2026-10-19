import { createPluginRegistrySourceDescriptorV1, RegistryFetchErrorV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin, readPluginUiContributionSupplies } from '@/sync/domains/plugins/ui/projectionUnion';

/** Preserve every proven supplier, including its retained offline declaration. */
export function projectPluginRegistrySources(projection: PluginUiProjectionModel | null): readonly RegistrySourceDescriptorV1[] {
    return Object.values(projection?.registrySourcesById ?? {}).map(entry => {
        const origin = readPluginUiContributionOrigin(entry);
        const supplies = readPluginUiContributionSupplies(entry);
        if (Reflect.get(entry, 'hostCompatibility') === 'conflict' && !origin) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        return createPluginRegistrySourceDescriptorV1({ pluginId: entry.pluginId, definition: entry.definition,
            suppliers: supplies.length > 0 ? supplies.map(supply => supply.machineId) : origin ? [origin.machineId] : [] });
    });
}
