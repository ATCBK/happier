import type { CapabilityApplyTimingInputV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { readSessionCapabilityAgentFactsV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { findCatalogEntry } from '@/agent/catalog/registry';
import { resolveAgentSkillsCapability } from '@/agent/skills/resolveAgentSkillsCapability';
import { getVendorResumeSupport } from './catalogHooks';

/** Timing consumes the Agent catalog's declaration and its existing experimental runtime predicate. */
export async function resolveCapabilityApplyAgentFacts(input: Readonly<{
  agentId: string; metadata: unknown; sessionRunning: boolean;
}>): Promise<CapabilityApplyTimingInputV1['agent']> {
  const published = readSessionCapabilityAgentFactsV1(input.metadata);
  if (published) return published;
  const entry = findCatalogEntry(input.agentId);
  let vendorResume = entry?.vendorResumeSupport ?? 'unsupported';
  if (input.sessionRunning && vendorResume === 'experimental') {
    const predicate = await getVendorResumeSupport(input.agentId);
    if (!predicate({ runtimeDescriptorV1: readRuntimeDescriptorV1FromMetadata(input.metadata) ?? undefined })) vendorResume = 'unsupported';
  }
  return { vendorResume, skillsLiveReload: resolveAgentSkillsCapability(input.agentId).liveReload };
}
