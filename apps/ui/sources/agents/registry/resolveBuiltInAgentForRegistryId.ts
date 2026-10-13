import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';

/** Registry identities are Agent-owned discovery facts, not routing aliases. */
export function resolveBuiltInAgentForRegistryId(
    catalogEntries: readonly ResolvedAgentCatalogEntry[],
    acpId: string,
): ResolvedAgentCatalogEntry | null {
    return catalogEntries.find(entry => entry.isBuiltIn && entry.acpRegistryIds?.includes(acpId)) ?? null;
}
