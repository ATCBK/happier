import type { CapabilityApplyTimingInputV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { readSessionCapabilityAgentFactsV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { findCatalogEntry } from '@/agent/catalog/registry';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { resolveAgentSkillsCapability } from '@/agent/skills/resolveAgentSkillsCapability';
import { getCatalogEntryVendorResumeSupport, getVendorResumeSupport } from './catalogHooks';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

/** Timing consumes the Agent catalog's declaration and its existing experimental runtime predicate. */
export async function resolveCapabilityApplyAgentFacts(input: Readonly<{
  agentId: string; metadata: unknown; sessionRunning: boolean;
  registry?: ResolvedExecutablePluginRuntimeRegistry;
  /** Present (including null) when a Session owns an exact retained Agent source. */
  catalogEntry?: AgentCatalogEntry | null;
}>): Promise<CapabilityApplyTimingInputV1['agent']> {
  const published = readSessionCapabilityAgentFactsV1(input.metadata);
  if (published) return published;
  const scopedEntry = Object.hasOwn(input, 'catalogEntry');
  const entry = scopedEntry ? input.catalogEntry : input.registry
    ? input.registry.contributes.catalogEntriesById[input.agentId]
    : findCatalogEntry(input.agentId);
  let vendorResume = entry?.vendorResumeSupport ?? 'unsupported';
  if (input.sessionRunning && vendorResume === 'experimental') {
    const predicate = scopedEntry && entry
      ? await getCatalogEntryVendorResumeSupport(entry)
      : await getVendorResumeSupport(input.agentId, input.registry);
    if (!predicate({ runtimeDescriptorV1: readRuntimeDescriptorV1FromMetadata(input.metadata) ?? undefined })) vendorResume = 'unsupported';
  }
  return { vendorResume, skillsLiveReload: scopedEntry ? entry?.skills?.liveReload ?? 'unsupported'
    : resolveAgentSkillsCapability(input.agentId, input.registry?.contributes).liveReload };
}
