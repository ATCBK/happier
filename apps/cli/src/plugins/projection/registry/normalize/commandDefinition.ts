import type { PluginCommandContributionV2 } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey, qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-key';
import type { ResolvedCommandDefinition } from '../types';

export function toCommandDefinition(pluginId: string, definition: PluginCommandContributionV2): ResolvedCommandDefinition {
  return Object.freeze({
    ...definition,
    kindVersion: 1,
    actionId: buildQualifiedPluginContributionKey(qualifyPluginContributionReferenceV1(definition.action, pluginId)),
  });
}
