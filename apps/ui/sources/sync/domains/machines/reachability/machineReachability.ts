import { isMachineReachableV1, isMachineRequestReachabilityFailureV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { readMachineOnlineGraceMsFromEnv } from '@/utils/sessions/machineUtils';
import { createServerAccountScope, serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export type MachineReachabilityScope = ServerAccountScope;

export type MachineRequestReachabilityObservation = Readonly<{
    outcome: 'succeeded' | 'failed';
    observedAtMs: number;
}>;

type MachineRequestObservationInput = MachineReachabilityScope & Readonly<{
    machineId: string;
    observedAtMs?: number;
    /** A transport failure does not make a Machine unreachable through another route. */
    route?: 'loopback_direct';
}>;

const observations = new Map<string, MachineRequestReachabilityObservation>();
const listeners = new Set<() => void>();
let revision = 0;

function observationKey(scope: MachineReachabilityScope | null | undefined, machineId: string | null | undefined, route?: MachineRequestObservationInput['route']): string | null {
    const normalizedScope = createServerAccountScope(resolveServerProfileScopeIdForIdentifier(scope?.serverId), scope?.accountId);
    const normalizedMachineId = String(machineId ?? '').trim();
    return normalizedScope && normalizedMachineId
        ? serverAccountScopedResourceKey(normalizedScope, normalizedMachineId, ...(route ? [route] : []))
        : null;
}

function recordMachineRequestObservation(
    input: MachineRequestObservationInput,
    outcome: MachineRequestReachabilityObservation['outcome'],
): void {
    const key = observationKey(input, input.machineId, input.route);
    if (!key) return;
    const observedAtMs = input.observedAtMs ?? Date.now();
    const previous = observations.get(key);
    if (previous && previous.observedAtMs > observedAtMs) return;
    if (previous?.outcome === outcome && previous.observedAtMs === observedAtMs) return;
    observations.set(key, { outcome, observedAtMs });
    // Retain freshness for late-result ordering without reopening automatic readers.
    if (previous?.outcome === outcome) return;
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
    scope: MachineReachabilityScope | null | undefined,
    machineId: string | null | undefined,
    route?: MachineRequestObservationInput['route'],
): MachineRequestReachabilityObservation | null {
    const key = observationKey(scope, machineId, route);
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
 * The one Home/Account-scoped admission predicate for UI and Action readers.
 * Pushed presence proves the daemon is alive; a failed request overrides it until a later
 * reply or authenticated socket reconnect. Advancing heartbeats never clear that failure.
 */
export function isMachineReachable(
    scope: MachineReachabilityScope | null | undefined,
    machine: Readonly<{ id: string; active: boolean; activeAt?: number | null; revokedAt?: number | null }>,
    nowMs: number = Date.now(),
): boolean {
    if (!createServerAccountScope(scope?.serverId, scope?.accountId)) return false;
    return isMachineReachableV1({ machine, nowMs, graceMs: readMachineOnlineGraceMsFromEnv(),
        requestOutcome: readMachineRequestReachabilityObservation(scope, machine.id)?.outcome });
}

/** The protocol-owned verdict; a failed request overrides pushed presence until a later reply or reconnect. */
export const isMachineRequestReachabilityFailure = isMachineRequestReachabilityFailureV1;

export function clearMachineRequestReachabilityForMachine(scope: MachineReachabilityScope, machineId: string): void {
    const key = observationKey(scope, machineId);
    if (!key) return;
    const changed = observations.delete(key);
    const directKey = observationKey(scope, machineId, 'loopback_direct');
    const directChanged = directKey ? observations.delete(directKey) : false;
    if (!changed && !directChanged) return;
    revision += 1;
    for (const listener of listeners) listener();
}

export function clearMachineRequestReachabilityForScope(scope: MachineReachabilityScope): void {
    const normalizedScope = createServerAccountScope(resolveServerProfileScopeIdForIdentifier(scope.serverId), scope.accountId);
    if (!normalizedScope) return;
    const prefix = serverAccountScopedResourceKey(normalizedScope);
    let changed = false;
    for (const key of observations.keys()) {
        if (key.startsWith(prefix)) changed = observations.delete(key) || changed;
    }
    if (!changed) return;
    revision += 1;
    for (const listener of listeners) listener();
}

export function clearMachineRequestReachabilityForTest(): void {
    if (observations.size === 0) return;
    observations.clear();
    revision += 1;
    for (const listener of listeners) listener();
}
