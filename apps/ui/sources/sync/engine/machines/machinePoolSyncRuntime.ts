import * as React from 'react';

import { fireAndForget } from '@/utils/system/fireAndForget';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

import {
    invalidateMachinePoolProjection,
    observeMachinePoolProjection,
    refreshMachinePoolProjection,
    resetMachinePoolProjectionForTests,
} from './machinePoolProjection';

export { invalidateMachinePoolProjection } from './machinePoolProjection';

const machineRevisionByServerId = new Map<string, string>();

function registerMachinePoolProjectionDemand(serverIds: readonly string[]): () => void {
    const releases = serverIds.map(observeMachinePoolProjection);
    return () => {
        for (const release of releases) release();
    };
}

/**
 * Keeps the reconstructible Pool projection current through the shared Account-scoped snapshot
 * lifecycle. Machine snapshot changes invalidate availability through that same single-flight
 * owner; no Pool-local socket, polling loop, cursor or competing currentness engine is created.
 */
export function useMachinePoolProjectionSync(
    demandsRaw: readonly Readonly<{
        serverId: string;
        machineRevisionKey: string;
        transportEnabled: boolean;
        needsHydration: boolean;
    }>[],
): void {
    const accountLifetime = useActiveServerAccountScopeLifetime();
    const previousAccountLifetime = React.useRef(accountLifetime);
    const demandsKey = React.useMemo(() => JSON.stringify(
        [...new Map(demandsRaw
            .map((demand) => [
                demand.serverId.trim(),
                [demand.machineRevisionKey, demand.transportEnabled, demand.needsHydration] as const,
            ] as const)
            .filter(([serverId]) => Boolean(serverId))).entries()]
            .sort(([left], [right]) => left.localeCompare(right)),
    ), [demandsRaw]);
    const demands = React.useMemo(
        () => JSON.parse(demandsKey) as Array<[
            serverId: string,
            demand: [machineRevisionKey: string, transportEnabled: boolean, needsHydration: boolean],
        ]>,
        [demandsKey],
    );
    const serverIdsKey = React.useMemo(() => demands.map(([serverId]) => serverId).join('\u0000'), [demands]);

    React.useEffect(() => {
        const serverIds = serverIdsKey ? serverIdsKey.split('\u0000') : [];
        return registerMachinePoolProjectionDemand(serverIds);
    }, [serverIdsKey]);

    React.useEffect(() => {
        const accountChanged = previousAccountLifetime.current !== accountLifetime;
        previousAccountLifetime.current = accountLifetime;
        for (const [serverId, [machineRevisionKey, transportEnabled, needsHydration]] of demands) {
            if (!transportEnabled) {
                // Retain the observed Machine lifecycle revision while transport is disabled.
                // When a Home later advertises Pools, the Home-change loader owns the first read.
                machineRevisionByServerId.set(serverId, machineRevisionKey);
                continue;
            }
            const previousRevision = machineRevisionByServerId.get(serverId);
            const revisionChanged = previousRevision !== undefined && previousRevision !== machineRevisionKey;
            machineRevisionByServerId.set(serverId, machineRevisionKey);
            // Startup can begin a read before the active Account mounts. Its custody refusal
            // leaves no answer; renew that demand through the same trailing-read owner.
            const accountChangedForHome = accountChanged && accountLifetime?.isCurrent() === true
                && areServerProfileIdentifiersEquivalent(serverId, accountLifetime.scope.serverId);
            if (revisionChanged || accountChangedForHome) {
                fireAndForget(invalidateMachinePoolProjection(serverId), { tag: 'machinePools.projectionRefresh' });
            } else if (needsHydration) {
                fireAndForget(refreshMachinePoolProjection(serverId), { tag: 'machinePools.projectionHydration' });
            }
        }
    }, [accountLifetime, demands]);
}

export function resetMachinePoolSyncRuntimeForTests(): void {
    resetMachinePoolProjectionForTests();
    machineRevisionByServerId.clear();
}
