import type { ActionInputHints, PluginActionContributionV2 } from '@happier-dev/protocol';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';

/** The input facet shared by full Action normalization and admitted listings. */
export function projectPluginActionInputDefinition(definition: PluginActionContributionV2): Readonly<{
  id: string;
  inputSchema?: PluginActionContributionV2['inputSchema'];
  inputHints: ActionInputHints | null;
}> {
  return {
    id: definition.id,
    ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
    inputHints: normalizePluginActionInputHintsV2(definition.inputHints) ?? null,
  };
}
