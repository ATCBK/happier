import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { normalizePluginDeclarativeDocumentV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDocument';
import { PluginDeclarativeProjectedModelV1Schema, type PluginDeclarativeProjectedModelV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeProjectedModelV1';

/** Build a static fixture through the real document normalizer and wire schema. */
export function createPluginDeclarativeModelFixture(input: Readonly<{
    pluginId: string;
    localId: string;
    occurrenceId: string;
    document: Parameters<typeof normalizePluginDeclarativeDocumentV1>[0]['document'];
}>): PluginDeclarativeProjectedModelV1 {
    const identity = createPluginContributionIdentity({ pluginId: input.pluginId, localId: input.localId });
    const normalized = normalizePluginDeclarativeDocumentV1({
        pluginId: input.pluginId,
        occurrenceId: input.occurrenceId,
        actions: [],
        document: input.document,
    });
    return PluginDeclarativeProjectedModelV1Schema.parse({
        identity: {
            ...identity,
            qualifiedId: buildQualifiedPluginContributionKey(identity),
            occurrenceId: input.occurrenceId,
        },
        visible: true,
        requiredHostMethods: [],
        declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
        root: normalized.root,
    });
}
