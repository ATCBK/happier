import * as React from 'react';
import { captureMachineContributionRegistryProjectionScope } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';

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
    const active = useActiveServerSnapshot(!serverId);
    const effectiveServerId = serverId || active.serverId;
    const profilesGeneration = useServerProfilesGeneration();
    const scopes = React.useMemo(() => {
        const resolveScopeId = captureServerProfileScopeResolver();
        return (key ? key.split('\u0000') : []).map(machineId => ({ machineId,
            ...captureMachineContributionRegistryProjectionScope({ serverId: effectiveServerId, machineId }, resolveScopeId) }));
    }, [effectiveServerId, key, profilesGeneration]);
    const lastRef = React.useRef<ReadonlyMap<string, MachineCapabilitiesSnapshot | null>>(new Map());
    const scopeKey = JSON.stringify([serverId, accountId ?? null]);
    const lastScopeRef = React.useRef(scopeKey);
    const subscribeRevisions = React.useCallback((listener: () => void) => {
        const disposers = scopes.map(scope => scope.subscribe(listener));
        return () => disposers.forEach(dispose => dispose());
    }, [scopes]);
    const readRevisions = React.useCallback(() => JSON.stringify(scopes.map(scope => scope.readRevision())), [scopes]);
    const revisions = React.useSyncExternalStore(subscribeRevisions, readRevisions, readRevisions);
    const subscribe = React.useCallback((listener: () => void) => {
        const unsubscribes = scopes.map(scope => subscribeMachineCapabilitiesCacheState(scope.machineId, serverId,
            scope.readRevision() || null, listener, accountId));
        return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    }, [accountId, revisions, scopes, serverId]);
    const getSnapshot = React.useCallback(() => {
        const previous = lastRef.current;
        let changed = previous.size !== scopes.length;
        const next = new Map<string, MachineCapabilitiesSnapshot | null>();
        for (const scope of scopes) {
            const id = scope.machineId;
            const snapshot = getMachineCapabilitiesSnapshot(id, serverId,
                scope.readRevision() || null, accountId)
                ?? (lastScopeRef.current === scopeKey ? previous.get(id) ?? null : null);
            next.set(id, snapshot);
            if (previous.get(id) !== snapshot) changed = true;
        }
        if (!changed) return previous;
        lastScopeRef.current = scopeKey;
        lastRef.current = next;
        return next;
    }, [accountId, revisions, scopeKey, scopes, serverId]);
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
