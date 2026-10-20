import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { PreflightSessionControlsProbeAdapter } from './preflightSessionControlsProbeAdapterTypes';

/** Substitute only the plugin-native observation, retaining the host catalog and probe owners. */
export function preflightCatalogEntryFixture(agentId: CatalogAgentLookupId, adapter: PreflightSessionControlsProbeAdapter) {
  const entry = readAgentCatalogSnapshot().catalogEntriesById[agentId];
  if (!entry) throw new Error(`Missing bundled Agent fixture: ${agentId}`);
  return { ...entry, getPreflightSessionControlsProbeAdapter: async () => adapter };
}
