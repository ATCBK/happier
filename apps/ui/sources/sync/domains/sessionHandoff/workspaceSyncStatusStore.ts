import type { WorkspaceSyncStatusV1 } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { getWorkspaceSyncStatus, listWorkspaceSyncStatuses } from '@/sync/ops/workspaceSync';

export type WorkspaceSyncStatusScope = Readonly<{
    serverId?: string | null;
    controllerMachineId: string;
    relationshipId: string;
}>;

export type WorkspaceSyncStatusSnapshot = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';
    status: WorkspaceSyncStatusV1 | null;
    error: unknown | null;
}>;

type Entry = {
    scope: WorkspaceSyncStatusScope;
    snapshot: WorkspaceSyncStatusSnapshot;
    listeners: Set<() => void>;
    inFlight: Promise<WorkspaceSyncStatusV1 | null> | null;
    admissionGeneration: number;
    requestController: AbortController | null;
};

const entries = new Map<string, Entry>();
type ControllerRead = {
    scopes: Map<string, Readonly<{ scope: WorkspaceSyncStatusScope; generation: number }>>;
    inFlight: Promise<void>;
    invalidated: boolean;
    controller: AbortController;
};

const controllerReads = new Map<string, ControllerRead>();
const IDLE_SNAPSHOT: WorkspaceSyncStatusSnapshot = { phase: 'idle', status: null, error: null };

function keyFor(scope: WorkspaceSyncStatusScope): string {
    return JSON.stringify([scope.serverId ?? null, scope.controllerMachineId, scope.relationshipId]);
}

function controllerKeyFor(scope: Pick<WorkspaceSyncStatusScope, 'serverId' | 'controllerMachineId'>): string {
    return JSON.stringify([scope.serverId ?? null, scope.controllerMachineId]);
}

function entryFor(scope: WorkspaceSyncStatusScope): Entry {
    const key = keyFor(scope);
    const existing = entries.get(key);
    if (existing) return existing;
    const entry: Entry = { scope, snapshot: IDLE_SNAPSHOT, listeners: new Set(), inFlight: null, admissionGeneration: 0, requestController: null };
    entries.set(key, entry);
    return entry;
}

function publish(entry: Entry, snapshot: WorkspaceSyncStatusSnapshot): void {
    const previous = entry.snapshot;
    let status = snapshot.status;
    if (previous.status && status && previous.status !== status) {
        const alpha = sameStrictJsonValue(previous.status.endpointStates.alpha, status.endpointStates.alpha)
            ? previous.status.endpointStates.alpha : status.endpointStates.alpha;
        const beta = sameStrictJsonValue(previous.status.endpointStates.beta, status.endpointStates.beta)
            ? previous.status.endpointStates.beta : status.endpointStates.beta;
        const endpointStates = alpha === previous.status.endpointStates.alpha && beta === previous.status.endpointStates.beta
            ? previous.status.endpointStates : { alpha, beta };
        status = { ...status, endpointStates };
        if (sameStrictJsonValue(previous.status, status)) status = previous.status;
    }
    if (previous.phase === snapshot.phase && previous.status === status && previous.error === snapshot.error) return;
    if (snapshot.status !== status) snapshot = { ...snapshot, status };
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener();
}

export function getWorkspaceSyncStatusSnapshot(scope: WorkspaceSyncStatusScope): WorkspaceSyncStatusSnapshot {
    return entryFor(scope).snapshot;
}

export function subscribeWorkspaceSyncStatus(scope: WorkspaceSyncStatusScope, listener: () => void): () => void {
    const entry = entryFor(scope);
    entry.listeners.add(listener);
    return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
        entry.admissionGeneration += 1;
        entry.requestController?.abort();
        entry.requestController = null;
        entry.inFlight = null;
        if (entry.snapshot.phase === 'loading' || entry.snapshot.phase === 'refreshing') {
            publish(entry, { ...entry.snapshot, phase: 'idle', error: null });
        }
        const key = controllerKeyFor(scope);
        const read = controllerReads.get(key);
        read?.scopes.delete(keyFor(scope));
        // Mounted summary consumers subscribe before admitting a shared list read.
        // One departing relationship must not cancel another relationship's read.
        if (read && ![...read.scopes.values()].some(value => entryFor(value.scope).listeners.size > 0)) {
            controllerReads.delete(key);
            read.controller.abort();
        }
    };
}

export function setWorkspaceSyncStatus(scope: WorkspaceSyncStatusScope, status: WorkspaceSyncStatusV1): void {
    const entry = entryFor(scope);
    entry.admissionGeneration += 1;
    publish(entry, { phase: 'ready', status, error: null });
}

export function applyWorkspaceSyncStatusEvent(scope: WorkspaceSyncStatusScope, status: WorkspaceSyncStatusV1): void {
    if (status.relationshipId !== scope.relationshipId || status.controllerMachineId !== scope.controllerMachineId) return;
    setWorkspaceSyncStatus(scope, status);
}

/** Machine publications carry no private status; refresh only current consumers. */
export function invalidateWorkspaceSyncStatuses(controller: Readonly<{
    serverId: string | null;
    controllerMachineId: string;
}>): void {
    const scopes: WorkspaceSyncStatusScope[] = [];
    const currentRead = controllerReads.get(controllerKeyFor(controller));
    if (currentRead) {
        currentRead.invalidated = true;
        controllerReads.delete(controllerKeyFor(controller));
        currentRead.controller.abort();
    }
    for (const entry of entries.values()) {
        if (controllerKeyFor(entry.scope) !== controllerKeyFor(controller)) continue;
        entry.admissionGeneration += 1;
        if (entry.listeners.size > 0) scopes.push(entry.scope);
        else publish(entry, { ...entry.snapshot, phase: 'idle', error: null });
    }
    if (scopes.length > 0) void refreshWorkspaceSyncStatuses(scopes).catch(() => undefined);
}

export function refreshWorkspaceSyncStatus(scope: WorkspaceSyncStatusScope): Promise<WorkspaceSyncStatusV1 | null> {
    const entry = entryFor(scope);
    if (entry.inFlight) return entry.inFlight;
    publish(entry, {
        phase: entry.snapshot.status ? 'refreshing' : 'loading',
        status: entry.snapshot.status,
        error: null,
    });
    const admissionGeneration = entry.admissionGeneration;
    const controller = new AbortController();
    entry.requestController = controller;
    const inFlight = getWorkspaceSyncStatus({ ...scope, signal: controller.signal }).then(
        (status) => {
            if (entry.admissionGeneration !== admissionGeneration) return entry.snapshot.status;
            publish(entry, { phase: 'ready', status, error: null });
            return entry.snapshot.status;
        },
        (error: unknown) => {
            if (entry.admissionGeneration === admissionGeneration) {
                publish(entry, { phase: 'error', status: entry.snapshot.status, error });
            }
            throw error;
        },
    ).finally(() => {
        if (entry.inFlight === inFlight) {
            entry.inFlight = null;
            entry.requestController = null;
        }
    });
    entry.inFlight = inFlight;
    return inFlight;
}

/** One daemon list read serves every demanded relationship on this controller. */
export async function refreshWorkspaceSyncStatuses(scopes: readonly WorkspaceSyncStatusScope[]): Promise<void> {
    const controllers = new Map<string, WorkspaceSyncStatusScope>();
    for (const scope of scopes) controllers.set(controllerKeyFor(scope), scope);
    await Promise.all([...controllers].map(async ([key, controller]) => {
        const current = controllerReads.get(key);
        const read: ControllerRead = current ?? { scopes: new Map(), inFlight: Promise.resolve(), invalidated: false,
            controller: new AbortController() };
        for (const scope of scopes.filter((candidate) => controllerKeyFor(candidate) === key)) {
            const entry = entryFor(scope);
            const previous = read.scopes.get(keyFor(scope));
            if (previous) {
                if (previous.generation !== entry.admissionGeneration) read.invalidated = true;
                continue;
            }
            read.scopes.set(keyFor(scope), { scope, generation: entry.admissionGeneration });
            if (entry.snapshot.phase === 'idle' || entry.snapshot.phase === 'ready' || entry.snapshot.phase === 'error') {
                publish(entry, { phase: entry.snapshot.status ? 'refreshing' : 'loading', status: entry.snapshot.status, error: null });
            }
        }
        if (current) return await current.inFlight;
        read.inFlight = listWorkspaceSyncStatuses({ ...controller, signal: read.controller.signal }).then((statuses) => {
            if (read.invalidated || read.controller.signal.aborted) return;
            const byId = new Map(statuses
                .filter((status) => status.controllerMachineId === controller.controllerMachineId)
                .map((status) => [status.relationshipId, status] as const));
            for (const { scope, generation } of read.scopes.values()) {
                const entry = entryFor(scope);
                if (entry.admissionGeneration !== generation) continue;
                const status = byId.get(scope.relationshipId) ?? null;
                publish(entry, { phase: 'ready', status, error: null });
            }
        }, (error: unknown) => {
            for (const { scope, generation } of read.scopes.values()) {
                const entry = entryFor(scope);
                if (!read.invalidated && !read.controller.signal.aborted && entry.admissionGeneration === generation) {
                    publish(entry, { phase: 'error', status: entry.snapshot.status, error });
                }
            }
            throw error;
        }).finally(async () => {
            if (controllerReads.get(key) === read) controllerReads.delete(key);
            if (read.invalidated && !read.controller.signal.aborted) {
                const pending = [...read.scopes.values()].filter(({ scope }) => {
                    const entry = entryFor(scope);
                    return entry.listeners.size > 0;
                }).map(({ scope }) => scope);
                if (pending.length > 0) await refreshWorkspaceSyncStatuses(pending);
            }
        });
        controllerReads.set(key, read);
        await read.inFlight;
    }));
}

export function resetWorkspaceSyncStatusStoreForTests(): void {
    for (const entry of entries.values()) entry.requestController?.abort();
    for (const read of controllerReads.values()) read.controller.abort();
    entries.clear();
    controllerReads.clear();
}
