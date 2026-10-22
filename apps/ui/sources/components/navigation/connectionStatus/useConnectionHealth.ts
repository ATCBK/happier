import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useActiveSelectionMachineGroups } from '@/components/settings/machines/hooks/useActiveSelectionMachineGroups';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import {
    useAllMachines,
    useMachineListByServerId,
    useMachineListForServer,
    useMachineListStatusByServerId,
    useMachineListStatusForServer,
    useEndpointConnectivity,
    useSocketStatus,
    useSyncError,
} from '@/sync/domains/state/storage';
import {
    getAppliedActiveServerSnapshot,
    isAppliedActiveServerRuntimeAvailable,
    subscribeAppliedActiveServer,
    subscribeAppliedActiveServerRuntimeAvailability,
} from '@/sync/runtime/orchestration/connectionManager';
import { useHomeViewSelectionSettings } from '@/hooks/server/useHomeViewSelectionSettings';
import { resolveMachineReachability, type MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { resolveConnectionHealthPresentation } from './connectionHealthPresentation';
import { resolveConnectionHealth } from './resolveConnectionHealth';

function isMachineReadyForConnectionHealth(machine: Readonly<{ daemonState?: unknown }>): boolean {
    const daemonState = machine.daemonState;
    if (!daemonState || typeof daemonState !== 'object') {
        return true;
    }
    const status = (daemonState as { status?: unknown }).status;
    if (typeof status !== 'string') {
        return true;
    }
    return status === 'running';
}

function resolveObservedMachinePresence(machines: readonly Machine[], scope: MachineReachabilityScope | null | undefined, nowMs: number) {
    const onlineMachines: Machine[] = [];
    let unknownCount = 0;
    for (const machine of machines) {
        const reachability = resolveMachineReachability(scope, machine, nowMs);
        if (reachability === 'reachable') onlineMachines.push(machine);
        else if (reachability === 'unknown') unknownCount += 1;
    }
    return { onlineMachines, unknownCount };
}

export function useConnectionHealth() {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const allMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const {
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
    } = useHomeViewSelectionSettings();

    const activeServerSnapshot = useActiveServerSnapshot();
    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles().slice();
        } catch {
            return [];
        }
    }, [activeServerSnapshot.generation]);

    const activeSelectionMachineGroups = useActiveSelectionMachineGroups({
        activeServerSnapshot,
        allMachines,
        serverProfiles,
        machineListByServerId,
        machineListStatusByServerId,
        settings: {
            serverSelectionGroups,
            serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId,
        },
    });
    const reachabilityRevision = useMachineReachabilityRevision();
    const presenceNowMs = useMachinePresenceNowMs(activeSelectionMachineGroups.visibleMachineGroups.flatMap(group => group.machines));
    const activeSyncError = React.useMemo(() => {
        return selectSyncErrorForServer(syncError, activeServerSnapshot.serverId);
    }, [activeServerSnapshot.serverId, syncError]);

    const primaryMachineLabel = React.useMemo(() => {
        const byId = new Map<string, (typeof activeSelectionMachineGroups.visibleMachineGroups)[number]['machines'][number]>();
        for (const group of activeSelectionMachineGroups.visibleMachineGroups) {
            if (group.status === 'loading' || group.status === 'signedOut') continue;
            for (const machine of group.machines) {
                if (machine.revokedAt) continue;
                byId.set(machine.id, machine);
            }
        }
        if (byId.size !== 1) return null;
        const machine = [...byId.values()][0] ?? null;
        const metadata = machine?.metadata && typeof machine.metadata === 'object' ? machine.metadata as { displayName?: unknown; host?: unknown } : null;
        const displayName = typeof metadata?.displayName === 'string' ? metadata.displayName.trim() : '';
        if (displayName) return displayName;
        const host = typeof metadata?.host === 'string' ? metadata.host.trim() : '';
        if (host) return host;
        return machine?.id ?? null;
    }, [activeSelectionMachineGroups.visibleMachineGroups]);

    const health = React.useMemo(() => {
        return resolveConnectionHealth({
            socketStatus: socketStatus.status,
            endpointStatus: endpointConnectivity.status,
            endpointReason: endpointConnectivity.reason,
            hasSyncError: Boolean(activeSyncError),
            syncErrorKind: activeSyncError?.kind,
            machineGroups: activeSelectionMachineGroups.visibleMachineGroups.map((group) => {
                if (group.status === 'loading' || group.status === 'signedOut') {
                    return {
                        machineCount: null,
                        onlineCount: null,
                        status: group.status,
                    };
                }

                const visibleMachines = group.machines.filter((machine) => !machine.revokedAt);
                const scope = group.accountScope;
                const { onlineMachines, unknownCount } = resolveObservedMachinePresence(visibleMachines, scope, presenceNowMs);
                return {
                    machineCount: visibleMachines.length,
                    onlineCount: onlineMachines.length,
                    unknownCount,
                    readyCount: onlineMachines.filter((machine) => isMachineSelectableForFleet(scope, machine, presenceNowMs) && isMachineReadyForConnectionHealth(machine)).length,
                    status: group.status,
                };
            }),
        });
    }, [
        activeSelectionMachineGroups.visibleMachineGroups,
        reachabilityRevision,
        presenceNowMs,
        activeSyncError,
        endpointConnectivity.reason,
        endpointConnectivity.status,
        socketStatus.status,
    ]);

    const presentation = React.useMemo(() => {
        return resolveConnectionHealthPresentation(health, {
            connected: theme.colors.status.connected,
            connecting: theme.colors.status.connecting,
            actionRequired: theme.colors.status.actionRequired,
            disconnected: theme.colors.status.disconnected,
            error: theme.colors.status.error,
            default: theme.colors.status.default,
        });
    }, [health, theme.colors.status]);

    return {
        ...health,
        ...presentation,
        primaryMachineLabel,
        endpointStatus: endpointConnectivity.status,
    };
}

/**
 * Active-Home-only health for always-mounted shell chrome. Unlike the
 * selection-wide hook above, this does not derive health from staged focus or
 * Home-view selection settings; it reads the applied Home's scoped projection.
 */
export function useActiveHomeConnectionHealth() {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const subscribeAppliedServer = React.useCallback(
        (listener: () => void) => subscribeAppliedActiveServer(() => listener()),
        [],
    );
    const appliedServerSnapshot = React.useSyncExternalStore(
        subscribeAppliedServer,
        getAppliedActiveServerSnapshot,
        getAppliedActiveServerSnapshot,
    );
    const appliedServerId = appliedServerSnapshot.serverId;
    const appliedMachines = useMachineListForServer(appliedServerId) ?? [];
    const { binding } = useServerCredentialAccountScopeBinding(appliedServerId);
    const accountScope = binding?.isCurrent() ? binding.scope : null;
    const reachabilityRevision = useMachineReachabilityRevision();
    const presenceNowMs = useMachinePresenceNowMs(appliedMachines);
    const machineListStatus = useMachineListStatusForServer(appliedServerId);
    const subscribeAppliedRuntime = React.useCallback(
        (listener: () => void) => subscribeAppliedActiveServerRuntimeAvailability(() => listener()),
        [],
    );
    const appliedServerRuntimeAvailable = React.useSyncExternalStore(
        subscribeAppliedRuntime,
        isAppliedActiveServerRuntimeAvailable,
        isAppliedActiveServerRuntimeAvailable,
    );
    const isAppliedHomeTransitioning = !appliedServerRuntimeAvailable;
    const activeSyncError = React.useMemo(() => (
        selectSyncErrorForServer(syncError, appliedServerId)
    ), [appliedServerId, syncError]);

    const visibleMachines = React.useMemo(
        () => appliedMachines.filter((machine) => !machine.revokedAt),
        [appliedMachines],
    );
    const { onlineMachines, unknownCount } = React.useMemo(
        () => resolveObservedMachinePresence(visibleMachines, accountScope, presenceNowMs),
        [visibleMachines, accountScope, presenceNowMs, reachabilityRevision],
    );
    const primaryMachineLabel = React.useMemo(() => {
        if (visibleMachines.length !== 1) return null;
        const machine = visibleMachines[0];
        const metadata = machine?.metadata && typeof machine.metadata === 'object'
            ? machine.metadata as { displayName?: unknown; host?: unknown }
            : null;
        const displayName = typeof metadata?.displayName === 'string' ? metadata.displayName.trim() : '';
        if (displayName) return displayName;
        const host = typeof metadata?.host === 'string' ? metadata.host.trim() : '';
        return host || machine?.id || null;
    }, [visibleMachines]);

    const health = React.useMemo(() => resolveConnectionHealth({
        // Socket and endpoint status are singleton transport projections. The
        // connection manager's runtime-availability fact is the authority for
        // whether they can be attributed to the applied Home.
        socketStatus: isAppliedHomeTransitioning ? 'connecting' : socketStatus.status,
        endpointStatus: isAppliedHomeTransitioning ? 'connecting' : endpointConnectivity.status,
        endpointReason: isAppliedHomeTransitioning ? null : endpointConnectivity.reason,
        hasSyncError: Boolean(activeSyncError),
        syncErrorKind: activeSyncError?.kind,
        machineGroups: [{
            ...(machineListStatus === 'loading' || machineListStatus === 'signedOut'
                ? {
                    machineCount: null,
                    onlineCount: null,
                }
                : {
                    machineCount: visibleMachines.length,
                    onlineCount: onlineMachines.length,
                    unknownCount,
                    readyCount: onlineMachines.filter(machine => isMachineSelectableForFleet(accountScope, machine, presenceNowMs) && isMachineReadyForConnectionHealth(machine)).length,
                }),
            status: machineListStatus,
        }],
    }), [
        activeSyncError,
        endpointConnectivity.reason,
        endpointConnectivity.status,
        isAppliedHomeTransitioning,
        machineListStatus,
        onlineMachines,
        unknownCount,
        accountScope,
        presenceNowMs,
        socketStatus.status,
        visibleMachines.length,
    ]);
    const presentation = React.useMemo(() => resolveConnectionHealthPresentation(health, {
        connected: theme.colors.status.connected,
        connecting: theme.colors.status.connecting,
        actionRequired: theme.colors.status.actionRequired,
        disconnected: theme.colors.status.disconnected,
        error: theme.colors.status.error,
        default: theme.colors.status.default,
    }), [health, theme.colors.status]);

    return {
        ...health,
        ...presentation,
        primaryMachineLabel,
        endpointStatus: isAppliedHomeTransitioning ? 'connecting' : endpointConnectivity.status,
    };
}
