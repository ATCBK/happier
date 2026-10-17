import * as React from 'react';

import { getStorage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import {
    isMachineReachable,
    readMachineRequestReachabilityRevision,
    subscribeMachineRequestReachability,
} from '@/sync/domains/machines/reachability/machineReachability';
import { getMachineDisplayName, isMachineOnline, readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';

import {
    resolveSessionMachineReachabilityState,
    type SessionMachineReachability,
} from '@/sync/domains/machines/reachability/resolveSessionMachineReachability';

/**
 * What a pane header says about the machine a tab runs on ("~/happier on MacBook Pro", "MacBook Pro is
 * offline"): its name, its home folder for `~` paths, and whether it is reachable. Primitives only, so
 * a heartbeat that does not flip presence re-renders nothing, but reschedules the grace expiry.
 *
 * `reachability` is the existing session reachability vocabulary: `unknown` when the machine record
 * is not visible from here (a shared Session), which callers must not present as offline.
 */
export type MachinePresenceSummary = Readonly<{
    name: string | null;
    homeDir: string | null;
    reachability: SessionMachineReachability;
    /** The machine's last heartbeat while it is unreachable ("last seen 09:12"); null otherwise, so heartbeats re-render nothing. */
    lastSeenAt?: number | null;
}>;

type MachinePresenceStorageState = Parameters<typeof resolveServerScopedMachine>[0];

export function useMachinePresenceSummary(
    serverId: string | null | undefined,
    machineId: string | null | undefined,
): MachinePresenceSummary {
    return useMachinePresenceSummaries(serverId, [machineId ?? ''])[0]!;
}

/** All-machines daemon reads share the same presence lifecycle and earliest clock wake. */
export function useMachinePresenceSummaries(
    serverId: string | null | undefined,
    machineIds: readonly string[],
): readonly MachinePresenceSummary[] {
    const store = getStorage();
    const targetServerId = serverId?.trim() || getActiveServerSnapshot().serverId;
    const { binding } = useServerCredentialAccountScopeBinding(targetServerId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const cached = React.useRef<readonly MachinePresenceSummary[]>([]);
    const idsKey = JSON.stringify(machineIds);
    const ids = React.useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
    const readMachines = React.useCallback(() => ids.map(machineId => machineId
        ? resolveServerScopedMachine(store.getState() as MachinePresenceStorageState, targetServerId, machineId) : null),
    [store, targetServerId, ids]);
    const readSnapshot = React.useCallback((nowMs: number): readonly MachinePresenceSummary[] => {
        const next = readMachines().map((machine, index): MachinePresenceSummary => {
            const name = machine ? getMachineDisplayName(machine).trim() || null : null;
            const homeDir = machine?.metadata?.homeDir?.trim() || null;
            const reachability = resolveSessionMachineReachabilityState({
                // Missing credential identity is unknown, not a transport-offline verdict.
                machineIsKnown: Boolean(machine && scope),
                machineIsOnline: machine ? isMachineReachable(scope, machine, nowMs) : false,
            });
            const lastSeenAt = reachability === 'unreachable' && typeof machine?.activeAt === 'number' && machine.activeAt > 0
                ? machine.activeAt : null;
            const previous = cached.current[index];
            return previous && previous.name === name && previous.homeDir === homeDir && previous.reachability === reachability
                && previous.lastSeenAt === lastSeenAt ? previous : { name, homeDir, reachability, lastSeenAt };
        });
        if (next.length !== cached.current.length || next.some((value, index) => value !== cached.current[index])) cached.current = next;
        return cached.current;
    }, [readMachines, scope, ids]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot);
}

export type MachinePresenceMembership = Readonly<{
    onlineMachineIds: readonly string[];
    selectableMachineIds: readonly string[];
}>;

/** App-wide consumers need membership, not heartbeat timestamps or machine presentation. */
export function useMachinePresenceMembership(serverId: string | null): MachinePresenceMembership {
    const store = getStorage();
    const targetServerId = serverId?.trim() || getActiveServerSnapshot().serverId;
    const { binding } = useServerCredentialAccountScopeBinding(targetServerId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const cached = React.useRef<MachinePresenceMembership>({ onlineMachineIds: [], selectableMachineIds: [] });
    const readMachines = React.useCallback(() => {
        const state = store.getState();
        const activeMachines = Object.values(state.machines);
        const machines = targetServerId ? resolveServerScopedMachines({
            serverId: targetServerId,
            activeServerId: getActiveServerSnapshot().serverId,
            activeMachines,
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        }) ?? [] : activeMachines;
        return machines.filter(isMachineVisibleForSelection);
    }, [store, targetServerId]);
    const readSnapshot = React.useCallback((nowMs: number) => {
        const machines = readMachines();
        const onlineMachineIds = machines.filter(machine => isMachineReachable(scope, machine, nowMs))
            .map(machine => machine.id).sort((left, right) => left.localeCompare(right));
        const selectableMachineIds = machines.filter(machine => isMachineSelectableForFleet(scope, machine, nowMs))
            .map(machine => machine.id).sort((left, right) => left.localeCompare(right));
        const previous = cached.current;
        if (onlineMachineIds.length !== previous.onlineMachineIds.length
            || onlineMachineIds.some((id, index) => id !== previous.onlineMachineIds[index])
            || selectableMachineIds.length !== previous.selectableMachineIds.length
            || selectableMachineIds.some((id, index) => id !== previous.selectableMachineIds[index])) {
            cached.current = { onlineMachineIds, selectableMachineIds };
        }
        return cached.current;
    }, [readMachines, scope]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot);
}

/** React reads one immutable projection until one of its subscribed sources moves. */
function useMachinePresenceSnapshot<T>(
    readMachines: Parameters<typeof useMachinePresenceSubscription>[0],
    readSnapshot: (nowMs: number) => T,
): T {
    const store = getStorage();
    const getSnapshot = React.useMemo(() => {
        let cached: Readonly<{
            machines: ReturnType<typeof store.getState>['machines'];
            machineListByServerId: ReturnType<typeof store.getState>['machineListByServerId'];
            machineListStatusByServerId: ReturnType<typeof store.getState>['machineListStatusByServerId'];
            machinePresenceById: ReturnType<typeof store.getState>['machinePresenceById'];
            machinePresenceByServerId: ReturnType<typeof store.getState>['machinePresenceByServerId'];
            clockNowMs: number;
            requestRevision: number;
            value: T;
        }> | undefined;
        return () => {
            const state = store.getState();
            const clockNowMs = sessionListRuntimeClock.getNowMs();
            const requestRevision = readMachineRequestReachabilityRevision();
            if (cached && cached.machines === state.machines
                && cached.machineListByServerId === state.machineListByServerId
                && cached.machineListStatusByServerId === state.machineListStatusByServerId
                && cached.machinePresenceById === state.machinePresenceById
                && cached.machinePresenceByServerId === state.machinePresenceByServerId
                && cached.clockNowMs === clockNowMs
                && cached.requestRevision === requestRevision) return cached.value;
            // Wall time is captured only at a source transition. Reading it on
            // every getSnapshot can cross a lease between React's consistency
            // reads before the shared deadline callback has delivered its event.
            const value = readSnapshot(Date.now());
            cached = { machines: state.machines, machineListByServerId: state.machineListByServerId,
                machineListStatusByServerId: state.machineListStatusByServerId,
                machinePresenceById: state.machinePresenceById, machinePresenceByServerId: state.machinePresenceByServerId,
                clockNowMs, requestRevision, value };
            return value;
        };
    }, [store, readSnapshot]);
    const subscribe = useMachinePresenceSubscription(readMachines);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Detail summaries and membership age through the same existing lease deadline. */
function useMachinePresenceSubscription(
    readMachines: () => readonly (Parameters<typeof isMachineOnline>[0] | null)[],
): (listener: () => void) => () => void {
    const store = getStorage();
    return React.useCallback((listener: () => void) => {
        const token = {};
        const refresh = () => {
            let next: number | null = null;
            for (const machine of readMachines()) {
                const deadline = machine ? readMachineStatusNextRefreshAtMs(machine, Date.now()) : null;
                if (deadline !== null) next = next === null ? deadline : Math.min(next, deadline);
            }
            if (next === null) sessionListRuntimeClock.clearWake(token);
            else sessionListRuntimeClock.requestWake(token, next);
            listener();
        };
        const stopStore = store.subscribe((state, previous) => {
            if (state.machines !== previous.machines
                || state.machineListByServerId !== previous.machineListByServerId
                || state.machineListStatusByServerId !== previous.machineListStatusByServerId
                || state.machinePresenceById !== previous.machinePresenceById
                || state.machinePresenceByServerId !== previous.machinePresenceByServerId) refresh();
        });
        const stopClock = sessionListRuntimeClock.subscribe(refresh);
        const stopRequests = subscribeMachineRequestReachability(refresh);
        refresh();
        return () => { stopStore(); stopClock(); stopRequests(); sessionListRuntimeClock.clearWake(token); };
    }, [store, readMachines]);
}
