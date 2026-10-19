import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const workItemsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'workItems',
    project: ({ registry }) => ({
        family: 'workItems',
        entriesById: Object.freeze(Object.fromEntries((registry.workItems ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition })]];
        }))),
    }),
});
