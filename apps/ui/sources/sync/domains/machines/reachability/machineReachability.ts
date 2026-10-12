import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';

export type MachineRequestReachabilityObservation = Readonly<{
    outcome: 'succeeded' | 'failed';
    observedAtMs: number;
}>;

type MachineRequestObservationInput = Readonly<{
    serverId: string;
    machineId: string;
    observedAtMs?: number;
}>;

const observations = new Map<string, MachineRequestReachabilityObservation>();
const listeners = new Set<() => void>();
let revision = 0;

function observationKey(serverId: string | null | undefined, machineId: string | null | undefined): string | null {
    const normalizedServerId = String(serverId ?? '').trim();
    const normalizedMachineId = String(machineId ?? '').trim();
    return normalizedServerId && normalizedMachineId
        ? JSON.stringify([normalizedServerId, normalizedMachineId])
        : null;
}

function recordMachineRequestObservation(
    input: MachineRequestObservationInput,
    outcome: MachineRequestReachabilityObservation['outcome'],
): void {
    const key = observationKey(input.serverId, input.machineId);
    if (!key) return;
    const observedAtMs = input.observedAtMs ?? Date.now();
    const previous = observations.get(key);
    if (previous && previous.observedAtMs > observedAtMs) return;
    if (previous?.outcome === outcome && previous.observedAtMs === observedAtMs) return;
    observations.set(key, { outcome, observedAtMs });
    revision += 1;
    for (const listener of listeners) listener();
}

export function recordMachineRequestFailed(input: MachineRequestObservationInput): void {
    recordMachineRequestObservation(input, 'failed');
}

export function recordMachineRequestSucceeded(input: MachineRequestObservationInput): void {
    recordMachineRequestObservation(input, 'succeeded');
}

export function readMachineRequestReachabilityObservation(
    serverId: string | null | undefined,
    machineId: string | null | undefined,
): MachineRequestReachabilityObservation | null {
    const key = observationKey(serverId, machineId);
    return key ? observations.get(key) ?? null : null;
}

export function subscribeMachineRequestReachability(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function readMachineRequestReachabilityRevision(): number {
    return revision;
}

/**
 * Pushed presence proves that the daemon is alive on its server socket. A failed request proves
 * that this client cannot reach it, so only a later successful request may clear that failure.
 */
export function resolveMachineReachable(input: Readonly<{
    presenceReachable: boolean;
    presenceObservedAtMs: number | null;
    requestObservation: MachineRequestReachabilityObservation | null;
}>): boolean {
    if (!input.presenceReachable) return false;
    const request = input.requestObservation;
    if (!request || request.outcome === 'succeeded') return true;
    return false;
}

/** The one server-scoped reachability decision for UI and action readers. */
export function isMachineReachable(
    serverId: string | null | undefined,
    machine: Readonly<{ id: string; active: boolean; activeAt?: number | null; revokedAt?: number | null }>,
    nowMs: number = Date.now(),
): boolean {
    return resolveMachineReachable({
        presenceReachable: isMachineOnline(machine, nowMs),
        presenceObservedAtMs: typeof machine.activeAt === 'number' && machine.activeAt > 0 ? machine.activeAt : null,
        requestObservation: readMachineRequestReachabilityObservation(serverId, machine.id),
    });
}

export function countMachineReachability(
    serverId: string | null | undefined,
    machines: ReadonlyArray<Parameters<typeof isMachineReachable>[1] & Readonly<{ replacedByMachineId?: string | null }>>,
    nowMs: number = Date.now(),
): Readonly<{ online: number; offline: number }> {
    let online = 0;
    let offline = 0;
    for (const machine of machines) {
        if (isMachineReplaced(machine)) continue;
        if (isMachineReachable(serverId, machine, nowMs)) online += 1;
        else offline += 1;
    }
    return { online, offline };
}

const HOST_RPC_METHODS: ReadonlySet<string> = new Set(Object.values(RPC_METHODS));

/**
 * Only failures that say the target could not be reached may override pushed presence. The Home answers
 * `RPC_METHOD_NOT_AVAILABLE` when no daemon takes the method: for a host-catalog method, which every
 * daemon registers, that means the daemon is not answering; for any other (a plugin's) it is a capability gap.
 */
export function isMachineRequestReachabilityFailure(error: unknown, method?: string): boolean {
    const rpcErrorCode = readRpcErrorCode(error);
    if (rpcErrorCode === 'target_unavailable' || rpcErrorCode === 'machine_unavailable' || rpcErrorCode === 'machine_offline') {
        return true;
    }
    if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE && method !== undefined && HOST_RPC_METHODS.has(method)) {
        return true;
    }
    if (!error || typeof error !== 'object') return false;
    const code = 'code' in error ? String(error.code ?? '') : '';
    return code === 'MACHINE_RPC_TIMEOUT'
        || code === 'target_unavailable'
        || code === 'machine_unavailable'
        || code === 'machine_offline';
}

export function clearMachineRequestReachabilityForTest(): void {
    if (observations.size === 0) return;
    observations.clear();
    revision += 1;
    for (const listener of listeners) listener();
}
