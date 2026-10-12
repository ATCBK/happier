import * as React from 'react';

import { getStorage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import {
    readMachineRequestReachabilityObservation,
    resolveMachineReachable,
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
    const cached = React.useRef<readonly MachinePresenceSummary[]>([]);
    const idsKey = JSON.stringify(machineIds);
    const ids = React.useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
    const readMachines = React.useCallback(() => ids.map(machineId => machineId
        ? resolveServerScopedMachine(store.getState() as MachinePresenceStorageState, serverId, machineId) : null),
    [store, serverId, ids]);
    const getSnapshot = React.useCallback((): readonly MachinePresenceSummary[] => {
        const next = readMachines().map((machine, index): MachinePresenceSummary => {
            const name = machine ? getMachineDisplayName(machine).trim() || null : null;
            const homeDir = machine?.metadata?.homeDir?.trim() || null;
            const reachability = resolveSessionMachineReachabilityState({
                machineIsKnown: Boolean(machine),
                machineIsOnline: machine ? resolveMachineReachable({
                    presenceReachable: isMachineOnline(machine),
                    presenceObservedAtMs: typeof machine.activeAt === 'number' && machine.activeAt > 0 ? machine.activeAt : null,
                    requestObservation: readMachineRequestReachabilityObservation(serverId, ids[index]),
                }) : false,
            });
            const lastSeenAt = reachability === 'unreachable' && typeof machine?.activeAt === 'number' && machine.activeAt > 0
                ? machine.activeAt : null;
            const previous = cached.current[index];
            return previous && previous.name === name && previous.homeDir === homeDir && previous.reachability === reachability
                && previous.lastSeenAt === lastSeenAt ? previous : { name, homeDir, reachability, lastSeenAt };
        });
        if (next.length !== cached.current.length || next.some((value, index) => value !== cached.current[index])) cached.current = next;
        return cached.current;
    }, [readMachines, serverId, ids]);
    const subscribe = React.useCallback((listener: () => void) => {
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
        const stopStore = store.subscribe(refresh);
        const stopClock = sessionListRuntimeClock.subscribe(refresh);
        const stopRequests = subscribeMachineRequestReachability(refresh);
        refresh();
        return () => { stopStore(); stopClock(); stopRequests(); sessionListRuntimeClock.clearWake(token); };
    }, [store, readMachines]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
