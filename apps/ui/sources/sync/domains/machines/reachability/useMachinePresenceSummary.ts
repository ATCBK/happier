import * as React from 'react';

import { getStorage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, captureServerProfileScopeResolver, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import {
    isMachineReachable,
    resolveMachineReachability,
    readMachineRequestReachabilityRevision,
    subscribeMachineRequestReachability,
} from '@/sync/domains/machines/reachability/machineReachability';
import { getMachineDisplayName, isMachineOnline, readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';

import type { SessionMachineReachability } from '@/sync/domains/machines/reachability/resolveSessionMachineReachability';

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
    /** The name as a sentence uses it ("Reading it from {machine}"): "this machine" while its details load or are locked. */
    sentenceName?: string | null;
    homeDir: string | null;
    reachability: SessionMachineReachability;
    /** Distinguishes a retained unobserved row from a shared Session's invisible Machine. */
    machineIsKnown?: boolean;
    /** The machine's last heartbeat while it is unreachable ("last seen 09:12"); null otherwise, so heartbeats re-render nothing. */
    lastSeenAt?: number | null;
}>;

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
    const readMachines = React.useCallback((resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver()) => {
        const state = store.getState();
        const activeServerId = getActiveServerSnapshot().serverId;
        const serverId = targetServerId || activeServerId;
        // Resolve Home inventory once, not once for each requested Machine.
        const machines = serverId ? resolveServerScopedMachines({
            serverId, activeServerId,
            get activeMachines() { return Object.values(state.machines); },
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        }, resolveScopeId) : null;
        return ids.map(machineId => {
            const id = machineId.trim();
            return !id ? null : serverId ? machines?.find(machine => machine.id === id) ?? null : state.machines[id] ?? null;
        });
    }, [store, targetServerId, ids]);
    const readSnapshot = React.useCallback((nowMs: number): readonly MachinePresenceSummary[] => {
        const resolveScopeId = captureServerProfileScopeResolver();
        const next = readMachines(resolveScopeId).map((machine, index): MachinePresenceSummary => {
            const name = machine ? getMachineDisplayName(machine).trim() || null : null;
            const sentenceName = machine ? getMachineSentenceName(machine, name ?? undefined) : null;
            const homeDir = machine?.metadata?.homeDir?.trim() || null;
            const reachability = machine ? resolveMachineReachability(scope, machine, nowMs, resolveScopeId) : 'unknown';
            const machineIsKnown = Boolean(machine);
            const lastSeenAt = reachability === 'unreachable' && typeof machine?.activeAt === 'number' && machine.activeAt > 0
                ? machine.activeAt : null;
            const previous = cached.current[index];
            return previous && previous.name === name && previous.sentenceName === sentenceName && previous.homeDir === homeDir
                && previous.reachability === reachability && previous.lastSeenAt === lastSeenAt && previous.machineIsKnown === machineIsKnown
                ? previous : { name, sentenceName, homeDir, reachability, lastSeenAt, machineIsKnown };
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
export function useMachinePresenceMembership(
    serverId: string | null,
    suppliedLifetime?: ServerAccountScopeLifetime | null,
): MachinePresenceMembership {
    const store = getStorage();
    const targetServerId = serverId?.trim() || getActiveServerSnapshot().serverId;
    const { binding } = useServerCredentialAccountScopeBinding(suppliedLifetime === undefined ? targetServerId : null);
    const subscribeSuppliedLifetime = React.useCallback((notify: () => void) => {
        const retirement = suppliedLifetime?.onRetire(notify);
        return () => retirement?.dispose();
    }, [suppliedLifetime]);
    const readSuppliedCurrentness = React.useCallback(() => suppliedLifetime?.isCurrent() === true, [suppliedLifetime]);
    const suppliedCurrent = React.useSyncExternalStore(subscribeSuppliedLifetime, readSuppliedCurrentness, readSuppliedCurrentness);
    // A composition owner can supply its already admitted exact Account. An
    // explicit absent, retired or different-Home owner never borrows another one.
    const scope = suppliedLifetime === undefined
        ? binding?.isCurrent() ? binding.scope : null
        : suppliedCurrent && suppliedLifetime
            && areServerProfileIdentifiersEquivalent(suppliedLifetime.scope.serverId, targetServerId)
            ? suppliedLifetime.scope : null;
    const cached = React.useRef<MachinePresenceMembership>({ onlineMachineIds: [], selectableMachineIds: [] });
    const readMachines = React.useCallback((resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver()) => {
        const state = store.getState();
        const activeMachines = Object.values(state.machines);
        const machines = targetServerId ? resolveServerScopedMachines({
            serverId: targetServerId,
            activeServerId: getActiveServerSnapshot().serverId,
            activeMachines,
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        }, resolveScopeId) ?? [] : activeMachines;
        return machines.filter(isMachineVisibleForSelection);
    }, [store, targetServerId]);
    const readSnapshot = React.useCallback((nowMs: number) => {
        const resolveScopeId = captureServerProfileScopeResolver();
        const machines = readMachines(resolveScopeId);
        const onlineMachineIds = machines.filter(machine => isMachineReachable(scope, machine, nowMs, resolveScopeId))
            .map(machine => machine.id).sort((left, right) => left.localeCompare(right));
        const selectableMachineIds = machines.filter(machine => isMachineSelectableForFleet(scope, machine, nowMs, resolveScopeId))
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
export function useMachinePresenceSnapshot<T>(
    readMachines: Parameters<typeof useMachinePresenceSubscription>[0],
    readSnapshot: (nowMs: number) => T,
    areEqual?: (left: T, right: T) => boolean,
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
            const nextValue = readSnapshot(Date.now());
            const value = cached && areEqual?.(cached.value, nextValue) ? cached.value : nextValue;
            cached = { machines: state.machines, machineListByServerId: state.machineListByServerId,
                machineListStatusByServerId: state.machineListStatusByServerId,
                machinePresenceById: state.machinePresenceById, machinePresenceByServerId: state.machinePresenceByServerId,
                clockNowMs, requestRevision, value };
            return value;
        };
    }, [store, readSnapshot, areEqual]);
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
