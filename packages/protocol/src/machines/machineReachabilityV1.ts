/** Existing daemon presence grace, shared by client projections. */
export const DEFAULT_MACHINE_ONLINE_GRACE_MS = 60_000;

export type MachinePresenceV1 = Readonly<{
    active: boolean;
    activeAt?: number | null;
    revokedAt?: number | null;
}>;

/** Presence projection; request failure custody stays with each transport owner. */
export function isMachineOnlineV1(machine: MachinePresenceV1, nowMs: number,
    graceMs: number = DEFAULT_MACHINE_ONLINE_GRACE_MS): boolean {
    if (typeof machine.revokedAt === 'number' && Number.isFinite(machine.revokedAt) && machine.revokedAt > 0) return false;
    if (graceMs <= 0) return machine.active === true;
    const activeAt = typeof machine.activeAt === 'number' ? machine.activeAt : 0;
    if (!activeAt || !Number.isFinite(activeAt)) return machine.active === true;
    return Math.max(0, nowMs - activeAt) <= graceMs;
}

export function isMachineReachableV1(input: Readonly<{
    machine: MachinePresenceV1;
    nowMs: number;
    graceMs?: number;
    requestOutcome?: 'succeeded' | 'failed' | null;
}>): boolean {
    return isMachineOnlineV1(input.machine, input.nowMs, input.graceMs)
        && input.requestOutcome !== 'failed';
}
