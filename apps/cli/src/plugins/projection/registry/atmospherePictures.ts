import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const atmospherePicturesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'atmospherePictures',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'atmospherePictures',
        entriesById: Object.freeze(Object.fromEntries((registry.atmospherePictures ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const id = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[id, Object.freeze({ id, pluginId: entry.pluginId, pluginVersion: entry.pluginVersion,
                definition: entry.definition, ...(origin ? { serverIdentityId: origin.serverIdentityId, materializationRef: origin.materializationRef } : {}) })]];
        }))),
    }),
});
