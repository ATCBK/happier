import * as React from 'react';
import { getMachineContributionRegistryProjectionRevision, subscribeMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';

import {
    getMachineCapabilitiesSnapshot,
    subscribeMachineCapabilitiesCacheState,
    type MachineCapabilitiesSnapshot,
} from '@/hooks/server/useMachineCapabilitiesCache';

/**
 * Observes the capability cache of several machines of one server at once, without fetching. The
 * server scope is explicit so a server switch re-subscribes to that server's entries.
 */
export function useMachinesCapabilitySnapshots(
    serverId: string,
    machineIds: readonly string[],
    accountId?: string | null,
): ReadonlyMap<string, MachineCapabilitiesSnapshot | null> {
    const key = [...new Set(machineIds)].join('\u0000');
    const lastRef = React.useRef<ReadonlyMap<string, MachineCapabilitiesSnapshot | null>>(new Map());
    const scopeKey = JSON.stringify([serverId, accountId ?? null]);
    const lastScopeRef = React.useRef(scopeKey);
    const subscribeRevisions = React.useCallback((listener: () => void) => {
        const disposers = (key ? key.split('\u0000') : []).map(machineId => subscribeMachineContributionRegistryProjectionInvalidation({ serverId, machineId }, listener));
        return () => disposers.forEach(dispose => dispose());
    }, [key, serverId]);
    const readRevisions = React.useCallback(() => JSON.stringify((key ? key.split('\u0000') : []).map(machineId =>
        getMachineContributionRegistryProjectionRevision({ serverId, machineId }))), [key, serverId]);
    const revisions = React.useSyncExternalStore(subscribeRevisions, readRevisions, readRevisions);
    const subscribe = React.useCallback((listener: () => void) => {
        const ids = key ? key.split('\u0000') : [];
        const unsubscribes = ids.map((id) => subscribeMachineCapabilitiesCacheState(id, serverId,
            getMachineContributionRegistryProjectionRevision({ serverId, machineId: id }) || null, listener, accountId));
        return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    }, [accountId, key, revisions, serverId]);
    const getSnapshot = React.useCallback(() => {
        const ids = key ? key.split('\u0000') : [];
        const previous = lastRef.current;
        let changed = previous.size !== ids.length;
        const next = new Map<string, MachineCapabilitiesSnapshot | null>();
        for (const id of ids) {
            const snapshot = getMachineCapabilitiesSnapshot(id, serverId,
                getMachineContributionRegistryProjectionRevision({ serverId, machineId: id }) || null, accountId)
                ?? (lastScopeRef.current === scopeKey ? previous.get(id) ?? null : null);
            next.set(id, snapshot);
            if (previous.get(id) !== snapshot) changed = true;
        }
        if (!changed) return previous;
        lastScopeRef.current = scopeKey;
        lastRef.current = next;
        return next;
    }, [accountId, key, revisions, scopeKey, serverId]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function readCapabilityResultData(snapshot: MachineCapabilitiesSnapshot | null, capabilityId: string): Record<string, unknown> | null {
    const result = snapshot?.response.results[capabilityId as keyof typeof snapshot.response.results];
    if (!result || !result.ok || !result.data || typeof result.data !== 'object') return null;
    return result.data as Record<string, unknown>;
}


/**
 * K5 — the daemon lists `cli.update.v1` among its `tool.systemTasks` kinds (presence = capability).
 * `null` while no detect of that machine is cached: unknown, not absent.
 */
export function readRemoteCliUpdateAdvertised(snapshot: MachineCapabilitiesSnapshot | null): boolean | null {
    const data = readCapabilityResultData(snapshot, 'tool.systemTasks');
    if (!data) return null;
    return Array.isArray(data.kinds) && data.kinds.includes('cli.update.v1');
}
