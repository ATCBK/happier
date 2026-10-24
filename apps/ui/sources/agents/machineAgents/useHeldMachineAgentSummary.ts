import * as React from 'react';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { machineAgentInventoryStore } from './machineAgentInventoryStore';
import type { MachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

/** Cache-only row context: no presence clocks, projection readers, authentication or detection. */
export function useHeldMachineAgentSummary(input: Readonly<{
    scope: ServerAccountScope | null;
    machineIds: readonly string[];
    agentId: string;
    definitionId?: string;
    publishedByMachineId?: ReadonlyMap<string, MachinePublishedMetadataV1['agentInventory']>;
    enabled?: boolean;
}>) {
    const idsKey = JSON.stringify([...new Set(input.machineIds)].sort());
    const serverId = input.scope?.serverId;
    const accountId = input.scope?.accountId;
    const summary = React.useMemo(() => {
        const keys = input.enabled !== false && serverId && accountId
            ? (JSON.parse(idsKey) as string[]).map(id => [id, serverAccountScopedResourceKey({ serverId, accountId }, 'machine-agents', id)] as const) : [];
        return machineAgentInventoryStore.createHeldAgentSummary(keys.map(([, key]) => key), input.agentId, input.definitionId,
            new Map(keys.map(([id, key]) => [key, input.publishedByMachineId?.get(id)])));
    }, [accountId, idsKey, input.agentId, input.definitionId, input.enabled, input.publishedByMachineId, serverId]);
    return React.useSyncExternalStore(summary.subscribe, summary.getSnapshot, summary.getSnapshot);
}
