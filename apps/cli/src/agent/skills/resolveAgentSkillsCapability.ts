import type { PluginAgentSkillsCapabilityV2 } from '@happier-dev/protocol';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

const NO_SKILLS: PluginAgentSkillsCapabilityV2 = Object.freeze({
  delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
});

/** Reads the same current lazy catalog projection used for Agent tool delivery. */
export function resolveAgentSkillsCapability(
  agentId: string,
  catalog: Pick<ResolvedContributionRegistry, 'catalogEntriesById'> = readAgentCatalogSnapshot(),
): PluginAgentSkillsCapabilityV2 {
  return catalog.catalogEntriesById[agentId]?.skills ?? NO_SKILLS;
}
