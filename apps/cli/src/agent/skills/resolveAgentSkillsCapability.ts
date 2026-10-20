import type { PluginAgentSkillsCapabilityV2 } from '@happier-dev/protocol';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { FoundNativeSkillScanInput } from '@/prompts/skills/native/scanNativeSkillRoots';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';

type SkillCatalog = Readonly<{ catalogEntriesById: Readonly<Record<string,
  Pick<AgentCatalogEntry, 'skills' | 'resolveNativeSkillDirectories' | 'resolveNativePluginSkillRoots' | 'resolveProbePluginSettings'>>> }>;

const NO_SKILLS: PluginAgentSkillsCapabilityV2 = Object.freeze({
  delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
});

/** Reads the same current lazy catalog projection used for Agent tool delivery. */
export function resolveAgentSkillsCapability(
  agentId: string,
  catalog: SkillCatalog = readAgentCatalogSnapshot(),
): PluginAgentSkillsCapabilityV2 {
  return catalog.catalogEntriesById[agentId]?.skills ?? NO_SKILLS;
}

/** Listing and byte revalidation consume the same current Agent discovery authority. */
export function resolveAgentFoundSkillSources(catalog: SkillCatalog = readAgentCatalogSnapshot()): FoundNativeSkillScanInput['agents'] {
  return Object.entries(catalog.catalogEntriesById).map(([agentId, entry]) => ({ agentId,
    nativeRoots: entry.skills?.nativeRoots, resolveNativePluginSkillRoots: entry.resolveNativePluginSkillRoots }));
}

/** The Agent interprets its exact non-secret Settings; the host owns filesystem discovery. */
export async function resolveAgentNativeSkillDirectories(agentId: string, input: Readonly<{
  catalog?: SkillCatalog; sessionMetadata?: unknown; signal?: AbortSignal;
}> = {}): Promise<readonly string[]> {
  const entry = (input.catalog ?? readAgentCatalogSnapshot()).catalogEntriesById[agentId];
  if (!entry?.resolveNativeSkillDirectories) return [];
  const pluginSettings = await entry.resolveProbePluginSettings?.({ signal: input.signal });
  if (!pluginSettings) throw new Error('Native skill launch settings are unavailable');
  input.signal?.throwIfAborted();
  const directories = await entry.resolveNativeSkillDirectories({ pluginSettings,
    runtimeDescriptorV1: readRuntimeDescriptorV1FromMetadata(input.sessionMetadata) ?? undefined });
  input.signal?.throwIfAborted();
  return directories;
}
