import { RPC_ERROR_CODES, readRpcErrorCode } from '../rpc/errors.js';

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

/**
 * Only an explicit target-unavailable verdict (the Machine row exists but no daemon of it is connected to this
 * Home) is a request-reachability failure. A missing method, a deadline or an answered error is not: none of them
 * says anything about the Machine as a whole. UI and CLI readers feed this verdict to `isMachineReachableV1`.
 */
export function isMachineRequestReachabilityFailureV1(error: unknown): boolean {
    const rpcErrorCode = readRpcErrorCode(error);
    if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return false;
    if (rpcErrorCode === 'target_unavailable' || rpcErrorCode === 'machine_unavailable' || rpcErrorCode === 'machine_offline') {
        return true;
    }
    if (!error || typeof error !== 'object') return false;
    const code = 'code' in error ? String(error.code ?? '') : '';
    // A caller deadline measures waiting, not target availability. Slow domain
    // work can exhaust it while presence and unrelated operations stay healthy.
    return code === 'target_unavailable'
        || code === 'machine_unavailable'
        || code === 'machine_offline';
}
