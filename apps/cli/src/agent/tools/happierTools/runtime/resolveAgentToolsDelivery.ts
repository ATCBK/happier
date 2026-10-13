import type { AgentToolsDelivery } from '@happier-dev/protocol';

import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

export type { AgentToolsDelivery } from '@happier-dev/protocol';

/**
 * The resolved Agent catalog is the single current projection for bundled and
 * installed Agent facts. An absent declaration never inherits delivery from an
 * Agent id, runtime kind, or tool inventory.
 */
export function resolveAgentToolsDelivery(
  agentId: string,
  catalog: Pick<ResolvedContributionRegistry, 'catalogEntriesById'> = readAgentCatalogSnapshot(),
): AgentToolsDelivery {
  return catalog.catalogEntriesById[agentId]?.toolDelivery ?? 'unsupported';
}
