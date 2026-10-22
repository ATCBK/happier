import * as React from 'react';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useMachinePresenceSummary } from './useMachinePresenceSummary';
import {
    resolveSessionMachineReachability,
    type SessionMachineReachability,
} from '@/components/sessions/model/resolveSessionMachineReachability';
import { useSessionMachineDisplayIdentity, useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';

export function useSessionReachableMachineTarget(sessionId: string, serverId?: string | null): { machineId: string; basePath: string } | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    return useSessionMachineTarget(resolvedSessionId, serverId);
}

export function useSessionMachineReachability(sessionId: string, serverId?: string | null): Readonly<{
    machineReachable: boolean;
    machineOnline: boolean;
    machineRpcTargetAvailable: boolean;
    machineReachability: SessionMachineReachability;
    /** The machine's last heartbeat, said only while it is unreachable: the honest time of the last known state. */
    machineLastSeenAt: number | null;
}> {
    const machineTarget = useSessionReachableMachineTarget(sessionId, serverId);
    const displayIdentity = useSessionMachineDisplayIdentity(sessionId, serverId);
    const resolvedMachineId = machineTarget?.machineId ?? (displayIdentity.machineId || null);

    const presence = useMachinePresenceSummary(serverId, resolvedMachineId);
    const machineKnown = presence.machineIsKnown ?? presence.reachability !== 'unknown';
    const machineOnline = presence.reachability === 'reachable';

    const machineReachable = resolveSessionMachineReachability({
        machineIsKnown: machineKnown,
        machineIsOnline: machineOnline,
    });
    const machineReachability = presence.reachability;

    const machineRpcTargetAvailable = Boolean(machineTarget?.basePath) && machineReachable;

    const machineLastSeenAt = presence.lastSeenAt ?? null;

    return React.useMemo(() => ({
        machineReachable,
        machineOnline,
        machineRpcTargetAvailable,
        machineReachability,
        machineLastSeenAt,
    }), [machineReachability, machineReachable, machineRpcTargetAvailable, machineOnline, machineLastSeenAt]);
}
