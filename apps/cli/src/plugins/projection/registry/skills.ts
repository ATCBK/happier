import { projectPluginSkillDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/skills';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const skillsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'skills',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'skills',
        entriesById: Object.freeze(Object.fromEntries((registry.skills ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const declaration = projectPluginSkillDeclarationV1({ pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion,
                ...(entry.pluginName ? { pluginName: entry.pluginName } : {}), definition: entry.definition });
            const executionOrigin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[declaration.id, Object.freeze({ ...declaration,
                ...(executionOrigin ? { executionOrigin } : {}) })]];
        }))),
    }),
});
