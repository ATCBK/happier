import { isMachineReachableV1, isMachineRequestReachabilityFailureV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { readMachineOnlineGraceMsFromEnv } from '@/utils/sessions/machineUtils';
import { createServerAccountScope, serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import type { SessionMachineReachability } from './resolveSessionMachineReachability';

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
// A transport withdrawal invalidates retained presence, not Machine identity.
// Each fresh ingress/read re-observes only its own Machine in that exact scope.
const withdrawnPresence = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const recoveryListeners = new Set<(scope: MachineReachabilityScope, machineId: string) => void>();
let revision = 0;

function presenceScopeKey(scope: MachineReachabilityScope | null | undefined, resolveScopeId: ProfileScopeResolver = resolveServerProfileScopeIdForIdentifier): string | null {
    const normalized = createServerAccountScope(resolveScopeId(scope?.serverId), scope?.accountId);
    return normalized ? serverAccountScopedResourceKey(normalized) : null;
}

function publishReachabilityChange(): void {
    revision += 1;
    for (const listener of listeners) listener();
}

/** Called by the existing Account socket's transport-withdrawal edge. Reconnect alone is not a presence observation. */
export function withdrawMachinePresenceForScope(scope: MachineReachabilityScope): void {
    const key = presenceScopeKey(scope);
    if (!key) return;
    withdrawnPresence.set(key, new Set());
    publishReachabilityChange();
}

/** Capture before an HTTP read so a pre-withdrawal response cannot restore old presence. */
export function captureMachinePresenceObservation(scope: MachineReachabilityScope | null): (machineIds: readonly string[]) => void {
    const key = presenceScopeKey(scope);
    const captured = key ? withdrawnPresence.get(key) : undefined;
    return machineIds => {
        if (!key || !captured || withdrawnPresence.get(key) !== captured) return;
        let changed = false;
        for (const machineId of machineIds) {
            if (!captured.has(machineId)) { captured.add(machineId); changed = true; }
        }
        if (changed) publishReachabilityChange();
    };
}

function observationKey(scope: MachineReachabilityScope | null | undefined, machineId: string | null | undefined, route?: MachineRequestObservationInput['route'], resolveScopeId: ProfileScopeResolver = resolveServerProfileScopeIdForIdentifier): string | null {
    const normalizedScope = createServerAccountScope(resolveScopeId(scope?.serverId), scope?.accountId);
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
    resolveScopeId?: ProfileScopeResolver,
): MachineRequestReachabilityObservation | null {
    const key = observationKey(scope, machineId, route, resolveScopeId);
    return key ? observations.get(key) ?? null : null;
}

export function subscribeMachineRequestReachability(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Authenticated daemon reconnects wake retired reads even when no failed request was cached. */
export function subscribeMachineRequestRecovery(listener: (scope: MachineReachabilityScope, machineId: string) => void): () => void {
    recoveryListeners.add(listener);
    return () => { recoveryListeners.delete(listener); };
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
    resolveScopeId?: ProfileScopeResolver,
): boolean {
    return resolveMachineReachability(scope, machine, nowMs, resolveScopeId) === 'reachable';
}

/** Shared presence verdict; unknown never supplies execution admission. */
export function resolveMachineReachability(
    scope: MachineReachabilityScope | null | undefined,
    machine: Parameters<typeof isMachineReachable>[1],
    nowMs: number = Date.now(),
    resolveScopeId?: ProfileScopeResolver,
): SessionMachineReachability {
    const key = presenceScopeKey(scope, resolveScopeId);
    if (!key) return 'unknown';
    const requestOutcome = readMachineRequestReachabilityObservation(scope, machine.id, undefined, resolveScopeId)?.outcome;
    if ((typeof machine.revokedAt === 'number' && Number.isFinite(machine.revokedAt) && machine.revokedAt > 0)
        || requestOutcome === 'failed') return 'unreachable';
    const observedSinceWithdrawal = withdrawnPresence.get(key);
    if (observedSinceWithdrawal && !observedSinceWithdrawal.has(machine.id)) return 'unknown';
    return isMachineReachableV1({ machine, nowMs, graceMs: readMachineOnlineGraceMsFromEnv(), requestOutcome })
        ? 'reachable' : 'unreachable';
}

/** The protocol-owned verdict; a failed request overrides pushed presence until a later reply or reconnect. */
export const isMachineRequestReachabilityFailure = isMachineRequestReachabilityFailureV1;

export function clearMachineRequestReachabilityForMachine(scope: MachineReachabilityScope, machineId: string): void {
    const key = observationKey(scope, machineId);
    if (!key) return;
    const changed = observations.delete(key);
    const directKey = observationKey(scope, machineId, 'loopback_direct');
    const directChanged = directKey ? observations.delete(directKey) : false;
    if (changed || directChanged) {
        revision += 1;
        for (const listener of listeners) listener();
    }
    for (const listener of recoveryListeners) listener(scope, machineId);
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
    if (observations.size === 0 && withdrawnPresence.size === 0) return;
    observations.clear();
    withdrawnPresence.clear();
    revision += 1;
    for (const listener of listeners) listener();
}
