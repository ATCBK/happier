import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { ResolvedConfiguredAcpBackend } from '@/agent/acp/catalog/configured/resolveBackend';
import { getVendorResumeSupport } from './catalogHooks';

/** Automatic stop and inactive launch consume the same admitted resume facts. */
export async function isSessionResumeSupported(input: Readonly<{
  agentId: CatalogAgentId | null;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  configuredBackend?: ResolvedConfiguredAcpBackend | null;
}>): Promise<boolean> {
  if (!input.agentId) return false;
  if ('configuredBackend' in input) return input.configuredBackend?.capabilities.supportsLoadSession === true;
  const supports = await getVendorResumeSupport(input.agentId);
  return supports(input.runtimeDescriptorV1 ? { runtimeDescriptorV1: input.runtimeDescriptorV1 } : {});
}
