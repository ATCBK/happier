import * as React from 'react';

import { resolveAgentCatalogProjection, type ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionSummary } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';

export type SessionAgentCatalogIdentity = Readonly<{
    entry: ResolvedAgentCatalogEntry;
    current: boolean;
    markAgentId: ResolvedAgentCatalogEntry['iconAgentId'];
}>;

/** Several Agents' catalog identities (names and marks) from the same inert summary, in the given order. */
export function useAgentCatalogIdentities(input: Readonly<{
    agentIds: readonly string[];
    machineId: string | null;
    serverId: string | null;
}>): readonly SessionAgentCatalogIdentity[] {
    const projection = useDaemonMergedProjectionSummary(input);
    const key = input.agentIds.join('\u0000');
    return React.useMemo(() => input.agentIds.map((agentId) => {
        const entry = resolveAgentCatalogProjection(agentId, {
            enabledAgentIds: [],
            mergedBackendProjectionById: projection.inputs?.mergedBackendProjectionById ?? null,
            mergedProviderProjectionById: projection.inputs?.mergedProviderProjectionById ?? null,
        });
        return { entry, current: projection.current, markAgentId: entry.isBuiltIn ? entry.iconAgentId : null };
        // `key` stands for the ids' contents, so a new array with the same ids keeps the identities.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [projection.inputs?.mergedBackendProjectionById, projection.inputs?.mergedProviderProjectionById, projection.current, key]);
}

/** Session chrome shares the existing inert catalog summary; reading a mark starts no daemon work. */
export function useSessionAgentCatalogIdentity(input: Readonly<{
    agentId: string;
    machineId: string | null;
    serverId: string | null;
}>): SessionAgentCatalogIdentity {
    const agentIds = React.useMemo(() => [input.agentId], [input.agentId]);
    return useAgentCatalogIdentities({ agentIds, machineId: input.machineId, serverId: input.serverId })[0]!;
}
