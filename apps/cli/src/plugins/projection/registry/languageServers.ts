import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const languageServersProjectionFamily = definePluginProjectionFamilyV2({
    family: 'languageServers',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'languageServers',
        entriesById: Object.freeze(Object.fromEntries((registry.languageServers ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const id = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[id, Object.freeze({ id, pluginId: entry.pluginId, pluginVersion: entry.pluginVersion,
                definition: entry.definition, ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});
