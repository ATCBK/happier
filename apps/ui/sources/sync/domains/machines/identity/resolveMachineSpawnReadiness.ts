import { isMachineReachable, type MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';

import { resolveMachineSpawnReadinessV1, type MachineSpawnReadinessV1 } from '@happier-dev/protocol/machines/machineSpawnReadinessV1';

export type MachineSpawnReadiness = MachineSpawnReadinessV1;

type MachineReadinessProbeState = boolean | 'unknown' | 'probing' | null | undefined;

/** The picker needs display/presence facts, not daemon-owned machine state. */
export type MachineSpawnReadinessMachine = Readonly<{
    id: string;
    active: boolean;
    activeAt?: number | null;
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
    availability?: Readonly<{ kind: 'available' | 'locked' }> | null;
}>;

export function resolveMachineSpawnReadiness(params: Readonly<{
    selectedMachineId?: string | null;
    machine?: MachineSpawnReadinessMachine | null;
    scope?: MachineReachabilityScope | null;
    rpcAvailable?: MachineReadinessProbeState;
    keyAvailable?: MachineReadinessProbeState;
    requireExactSpawnReadiness?: boolean;
    /** A restrictive caller veto; true never overrides current scoped reachability. */
    machineReachable?: boolean;
    nowMs?: number;
}>): MachineSpawnReadiness {
    return resolveMachineSpawnReadinessV1({ ...params,
        machineReachable: params.machineReachable !== false && Boolean(params.machine && isMachineReachable(params.scope, params.machine, params.nowMs)),
    });
}

export function canAttemptMachineSpawn(params: Readonly<{
    selectedMachineId?: string | null;
    machine?: Parameters<typeof resolveMachineSpawnReadiness>[0]['machine'];
    scope?: MachineReachabilityScope | null;
    spawnReadiness?: MachineSpawnReadiness | null;
    machineReachable?: boolean;
    nowMs?: number;
}>): boolean {
    const currentReadiness = resolveMachineSpawnReadiness({
        selectedMachineId: params.selectedMachineId,
        machine: params.machine,
        scope: params.scope,
        requireExactSpawnReadiness: true,
        machineReachable: params.machineReachable,
        nowMs: params.nowMs,
    });
    if (currentReadiness.status !== 'ready' && currentReadiness.status !== 'unknown' && currentReadiness.status !== 'probing') return false;
    const readiness = params.spawnReadiness ?? currentReadiness;
    return readiness.status === 'ready' || readiness.status === 'unknown' || readiness.status === 'probing';
}
