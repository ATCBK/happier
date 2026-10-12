import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type FleetMachine = Parameters<typeof resolveMachinePickerPresence>[0] & Readonly<{
    availability?: Readonly<{ kind: string }>;
}>;

/** Normalized Administration rows retain their census without admitting stale or unavailable members. */
export function isFleetMemberCurrent(member: Readonly<{ observation: 'live' | 'stale'; availability: string }>): boolean {
    return member.observation === 'live' && member.availability === 'online';
}

export function resolveFleetMachineAvailability(
    scope: MachineReachabilityScope | null | undefined,
    machine: FleetMachine,
    nowMs?: number,
): 'locked' | ReturnType<typeof resolveMachinePickerPresence>['status'] {
    return machine.availability?.kind === 'locked' ? 'locked' as const : resolveMachinePickerPresence(machine, nowMs, scope).status;
}

/** Administration's machine membership policy; retained inventory is not execution authority. */
export function isMachineSelectableForFleet(
    scope: MachineReachabilityScope | null | undefined,
    machine: FleetMachine,
    nowMs?: number,
): boolean {
    return isFleetMemberCurrent({ observation: 'live', availability: resolveFleetMachineAvailability(scope, machine, nowMs) });
}

/** Exact snapshot admission shared by all plugin supplies, without interpreting release facts. */
export function resolveFleetMachineRejection(params: Readonly<{
    serverIdentityId: string;
    machineId: string;
    machineSnapshots: readonly ServerMachineInventorySnapshotV1[];
}>): 'unknown' | 'missing' | 'stale' | 'offline' | 'revoked' | 'replaced' | null {
    const snapshot = params.machineSnapshots.find((candidate) => candidate.kind === 'resolved'
        && candidate.serverIdentityId === params.serverIdentityId);
    if (!snapshot || snapshot.kind !== 'resolved') return 'unknown';
    const machine = snapshot.machines.find((candidate) => candidate.id === params.machineId);
    if (!machine) return snapshot.settled === true ? 'missing' : 'unknown';
    if (snapshot.observation === 'stale') return 'stale';
    const availability = resolveFleetMachineAvailability(createServerAccountScope(snapshot.serverIdentityId, snapshot.accountId), machine);
    return availability === 'locked' ? 'unknown' : availability === 'online' ? null : availability;
}

export type FleetReadState = 'current' | 'resolving' | 'transportFailure' | 'failed';

/** A retry beside a healthy supply is unresolved coverage, not a fleet failure. */
export function resolveFleetReadState(states: readonly FleetReadState[]): 'current' | 'resolving' | 'failed' {
    if (states.includes('failed')) return 'failed';
    if (states.includes('resolving')
        || (states.includes('current') && states.includes('transportFailure'))) return 'resolving';
    return states.includes('transportFailure') ? 'failed' : 'current';
}

/** Domain owners supply identity/content; only admitted current supplies can disagree. */
export function resolveFleetSupplyAgreement<T>(params: Readonly<{
    supplies: readonly Readonly<{ value: T; selectable: boolean }>[];
    identity: (value: T) => string;
    content: (value: T) => string;
}>): Readonly<{
    variantsByIdentity: ReadonlyMap<string, ReadonlyMap<string, T>>;
    conflictingIdentities: readonly string[];
}> {
    const variantsByIdentity = new Map<string, Map<string, T>>();
    for (const supply of params.supplies) {
        if (!supply.selectable) continue;
        const identity = params.identity(supply.value);
        const variants = variantsByIdentity.get(identity) ?? new Map<string, T>();
        const content = params.content(supply.value);
        if (!variants.has(content)) variants.set(content, supply.value);
        variantsByIdentity.set(identity, variants);
    }
    return {
        variantsByIdentity,
        conflictingIdentities: [...variantsByIdentity].filter(([, variants]) => variants.size > 1).map(([identity]) => identity),
    };
}
