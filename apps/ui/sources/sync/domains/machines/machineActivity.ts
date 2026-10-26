import type { Machine } from '@/sync/domains/state/storageTypes';

export type MachineActivityUpdate = Readonly<Pick<Machine, 'id' | 'active' | 'activeAt'>>;

export type MachineActivityFacts = Readonly<{ active: boolean; activeAt?: number | null }>;
type ActivitySlice = { value: MachineActivityFacts; listeners: Set<() => void> };
// Current liveness is state, not an inventory revision or a derived-value cache.
// The admitted row/projection is its key: a different Home, Account or replacement
// row cannot borrow it, and retiring that row retires this index entry as well.
const activitySlices = new WeakMap<object, ActivitySlice>();

/** Rows are immutable content snapshots; live presence readers use this clock. */
export function readMachineActivity(machine: MachineActivityFacts): MachineActivityFacts {
    return activitySlices.get(machine)?.value ?? machine;
}

export function subscribeMachineActivity(machine: MachineActivityFacts, listener: () => void): () => void {
    let slice = activitySlices.get(machine);
    if (!slice) {
        slice = { value: { active: machine.active, activeAt: machine.activeAt }, listeners: new Set() };
        activitySlices.set(machine, slice);
    }
    slice.listeners.add(listener);
    return () => { slice.listeners.delete(listener); };
}

/** Machine-domain ingress updates only this Machine's liveness subscribers. */
export function publishMachineActivity(
    machine: MachineActivityFacts,
    activity: MachineActivityFacts,
    projections: readonly (MachineActivityFacts | null | undefined)[],
): void {
    let slice = activitySlices.get(machine);
    if (!slice) {
        slice = { value: { active: machine.active, activeAt: machine.activeAt }, listeners: new Set() };
        activitySlices.set(machine, slice);
    }
    const slices = new Set([slice]);
    for (const projection of projections) {
        if (!projection) continue;
        const existing = activitySlices.get(projection);
        if (existing) slices.add(existing);
        else activitySlices.set(projection, slice);
    }
    const listeners = new Set<() => void>();
    for (const target of slices) {
        target.value = activity;
        for (const listener of target.listeners) listeners.add(listener);
    }
    // Every projection observes the same committed fact before any reader wakes.
    for (const listener of listeners) listener();
}

/** A display is another view of this admitted row's clock, not a second clock. */
export function linkMachineActivity(machine: MachineActivityFacts, projection: MachineActivityFacts): void {
    let slice = activitySlices.get(machine);
    if (!slice) {
        slice = { value: { active: machine.active, activeAt: machine.activeAt }, listeners: new Set() };
        activitySlices.set(machine, slice);
    }
    activitySlices.set(projection, slice);
}

const placeholderContent = {
    seq: 0,
    revokedAt: null,
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
} as const;

/** A heartbeat supplies presence, never content or access authority. */
export function buildMachineActivityPlaceholder(update: MachineActivityUpdate): Machine {
    return { ...placeholderContent, id: update.id, active: update.active, activeAt: update.activeAt,
        createdAt: update.activeAt, updatedAt: update.activeAt };
}

export function isMachineActivityPlaceholder(machine: Machine): boolean {
    const placeholder = buildMachineActivityPlaceholder(machine);
    return Object.keys(machine).every(key => Object.hasOwn(placeholder, key))
        && Object.entries(placeholderContent).every(([key, value]) => machine[key as keyof Machine] === value);
}
