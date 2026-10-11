import * as React from 'react';

import { resolveAgentCatalogProjection, type ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionSummary } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';

export type SessionAgentCatalogIdentity = Readonly<{
    entry: ResolvedAgentCatalogEntry;
    current: boolean;
    markAgentId: ResolvedAgentCatalogEntry['iconAgentId'];
}>;

/** Session chrome shares the existing inert catalog summary; reading a mark starts no daemon work. */
export function useSessionAgentCatalogIdentity(input: Readonly<{
    agentId: string;
    machineId: string | null;
    serverId: string | null;
}>): SessionAgentCatalogIdentity {
    const projection = useDaemonMergedProjectionSummary(input);
    const entry = React.useMemo(() => resolveAgentCatalogProjection(input.agentId, {
        enabledAgentIds: [],
        mergedBackendProjectionById: projection.inputs?.mergedBackendProjectionById ?? null,
        mergedProviderProjectionById: projection.inputs?.mergedProviderProjectionById ?? null,
    }), [projection.inputs?.mergedBackendProjectionById, projection.inputs?.mergedProviderProjectionById, input.agentId]);
    return { entry, current: projection.current, markAgentId: entry.isBuiltIn ? entry.iconAgentId : null };
}
