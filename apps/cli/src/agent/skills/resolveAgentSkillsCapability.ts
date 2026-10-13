import type { PluginAgentSkillsCapabilityV2 } from '@happier-dev/protocol';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';

const NO_SKILLS: PluginAgentSkillsCapabilityV2 = Object.freeze({
  delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
});

/** Reads the same current lazy catalog projection used for Agent tool delivery. */
export function resolveAgentSkillsCapability(
  agentId: string,
  catalog: Readonly<{ catalogEntriesById: Readonly<Record<string, Readonly<{ skills?: PluginAgentSkillsCapabilityV2 }>>> }> = readAgentCatalogSnapshot(),
): PluginAgentSkillsCapabilityV2 {
  return catalog.catalogEntriesById[agentId]?.skills ?? NO_SKILLS;
}
