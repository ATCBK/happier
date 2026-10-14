import type { MachineVitalsSnapshotV1, MachineVitalsWatchResultV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import type { MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { projectMachineResourceSummaryV1, type MachineResourceSummaryV1, type MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import { createSharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import type {
    MachineResourceKey, MachineVitalsView, MachineVitalsRange, MachineResourceRpcResult,
    MachineVitalsReadInput, MachineVitalsHistoryReadInput, MachineVitalsWatchInput,
} from './machineRpc';

export type MachineResourceState = Readonly<{
    status: 'loading' | 'ready' | 'error' | 'not_reported';
    snapshot: MachineVitalsSnapshotV1 | null;
    summary: MachineResourceSummaryV1 | null;
    /** Cadence-derived freshness last observed at a read/watch answer; no client clock loop. */
    stale: boolean;
    samples: readonly MachineVitalsSampleV1[];
    /** The admitted Action/RPC refusal, retained without replacing its stable state category. */
    errorCode?: string;
}>;
export type MachineResourceStoreInput = MachineResourceKey & Readonly<{ view: MachineVitalsView }>;
export type MachineResourceHistoryState = Readonly<{ status: MachineResourceState['status']; history: MachineVitalsHistoryV1 | null; errorCode?: string }>;
export type MachineResourceClients = Readonly<{
    snapshotClient: (input: MachineVitalsReadInput) => Promise<MachineResourceRpcResult<MachineVitalsSnapshotV1>>;
    watchClient: (input: MachineVitalsWatchInput) => Promise<MachineResourceRpcResult<MachineVitalsWatchResultV1>>;
    historyClient: (input: MachineVitalsHistoryReadInput) => Promise<MachineResourceRpcResult<MachineVitalsHistoryV1>>;
}>;

export const EMPTY_MACHINE_RESOURCE_STATE: MachineResourceState = { status: 'loading', snapshot: null, summary: null, stale: false, samples: [] };
export const EMPTY_MACHINE_RESOURCE_HISTORY_STATE: MachineResourceHistoryState = { status: 'loading', history: null };
const NOT_REPORTED_STATE: MachineResourceState = { ...EMPTY_MACHINE_RESOURCE_STATE, status: 'not_reported' };
const NOT_REPORTED_HISTORY_STATE: MachineResourceHistoryState = { ...EMPTY_MACHINE_RESOURCE_HISTORY_STATE, status: 'not_reported' };

type ResourceUpdate =
    | Readonly<{ kind: 'snapshot'; snapshot: MachineVitalsSnapshotV1 }>
    | Readonly<{ kind: 'samples'; samples: readonly MachineVitalsSampleV1[]; retainDetails?: boolean }>
    | Readonly<{ kind: 'published_attention'; attention: MachineResourceAttentionV1 }>
    | Readonly<{ kind: 'freshness' }>
    | Readonly<{ kind: 'error' | 'not_reported'; errorCode?: string }>;
type HistoryInput = MachineResourceKey & Readonly<{ range: MachineVitalsRange }>;

function machineKey(input: MachineResourceKey): string { return JSON.stringify([input.serverId ?? null, input.expectedAccountId ?? null, input.machineId]); }
function retain<T>(previous: T, next: T): T { return JSON.stringify(previous) === JSON.stringify(next) ? previous : next; }

function retainSample(previous: MachineVitalsSampleV1 | null, next: MachineVitalsSampleV1): MachineVitalsSampleV1 {
    if (!previous) return next;
    return retain(previous, {
        ...next,
        cpu: retain(previous.cpu, next.cpu),
        memory: retain(previous.memory, next.memory),
        disk: retain(previous.disk, next.disk),
        network: retain(previous.network, next.network),
    });
}

function retainSeries(previous: MachineVitalsSnapshotV1['series5m'], next: MachineVitalsSnapshotV1['series5m']): MachineVitalsSnapshotV1['series5m'] {
    const points = (old: typeof previous.cpu, incoming: typeof previous.cpu) => {
        const byTime = new Map(old.map(point => [point.t, point]));
        return retain(old, incoming.map(point => {
            const existing = byTime.get(point.t);
            return existing && existing.y === point.y ? existing : point;
        }));
    };
    return retain(previous, {
        cpu: points(previous.cpu, next.cpu), memory: points(previous.memory, next.memory),
        networkRx: points(previous.networkRx, next.networkRx), networkTx: points(previous.networkTx, next.networkTx),
    });
}

function appendSamples(previous: readonly MachineVitalsSampleV1[], incoming: readonly MachineVitalsSampleV1[]): readonly MachineVitalsSampleV1[] {
    let result = previous;
    for (const sample of incoming) {
        if (sample.sampledAt <= (result.at(-1)?.sampledAt ?? -1)) continue;
        // The Overview's longest live range is one hour; older data comes from range reads.
        result = [...result.filter(point => point.sampledAt >= sample.sampledAt - 3_600_000), sample];
    }
    return result;
}

function applySnapshot(state: MachineResourceState, incoming: MachineVitalsSnapshotV1, now: number): MachineResourceState {
    const previous = state.snapshot;
    if (incoming.state === 'unavailable' && !incoming.sample && previous?.sample) {
        incoming = { ...incoming, sample: previous.sample, series5m: previous.series5m,
            ...(previous.attention && !incoming.attention ? { attention: previous.attention } : {}) };
    }
    const sample = incoming.sample ? retainSample(previous?.sample ?? null, incoming.sample) : null;
    const snapshot = previous ? retain(previous, {
        ...incoming, sample,
        series5m: retainSeries(previous.series5m, incoming.series5m),
        ...(incoming.attention ? { attention: retain(previous.attention, incoming.attention) } : {}),
    }) : incoming;
    const projected = projectMachineResourceSummaryV1(snapshot);
    const summary = state.summary && projected ? retain(state.summary, {
        ...projected,
        // Missing samples stay gaps in history; the figure keeps the last measurement.
        cpu: retain(state.summary.cpu, { ...projected.cpu, busyPct: projected.cpu.busyPct ?? state.summary.cpu.busyPct }), memory: retain(state.summary.memory, projected.memory),
        disk: retain(state.summary.disk, projected.disk), network: retain(state.summary.network, projected.network),
    }) : projected;
    const next: MachineResourceState = { status: 'ready', snapshot, summary, stale: false, samples: sample ? appendSamples(state.samples, [sample]) : state.samples };
    return retain(state, { ...next, stale: isMachineResourceStateStale(next, now) });
}

function applyUpdate(state: MachineResourceState, update: ResourceUpdate, now: number): MachineResourceState {
    if (update.kind === 'snapshot') return applySnapshot(state, update.snapshot, now);
    if (update.kind === 'freshness') {
        const stale = isMachineResourceStateStale(state, now);
        return state.stale === stale ? state : { ...state, stale };
    }
    if (update.kind === 'published_attention') {
        if (!state.snapshot) return state;
        const attention = retain(state.snapshot.attention, update.attention);
        return attention === state.snapshot.attention ? state : applySnapshot(state, { ...state.snapshot, attention }, now);
    }
    if (update.kind !== 'samples') {
        const { errorCode: _previousErrorCode, ...retained } = state;
        return retain(state, { ...retained, status: update.kind, stale: isMachineResourceStateStale(state, now),
            ...(update.errorCode ? { errorCode: update.errorCode } : {}) });
    }
    if (!state.snapshot) return state;
    let result = state;
    for (const incoming of update.samples) {
        const previous = result.snapshot!;
        if (incoming.sampledAt < (previous.sample?.sampledAt ?? -1)) continue;
        if (incoming.sampledAt === previous.sample?.sampledAt) {
            // A successful sibling answer also recovers a failed read at the same sampler frontier.
            // It is not a new chart point, and must not discard this view's retained details.
            if (result.status !== 'ready' || previous.state !== 'reporting') {
                result = applySnapshot(result, { ...previous, state: 'reporting', reason: undefined }, now);
            }
            continue;
        }
        // Another view only replaces the facts it supplied, not held detail it did not request.
        const sample = retainSample(previous.sample, update.retainDetails ? { ...previous.sample, ...incoming } : incoming);
        const point = (old: typeof previous.series5m.cpu, y: number | null) => [
            ...old.filter(p => p.t >= sample.sampledAt - 300_000),
            { t: sample.sampledAt, y },
        ];
        result = applySnapshot(result, {
            ...previous, state: 'reporting', reason: undefined, sample,
            series5m: {
                cpu: point(previous.series5m.cpu, sample.cpu.reported ? sample.cpu.busyPct : null),
                memory: point(previous.series5m.memory, sample.memory.reported ? sample.memory.availableBytes : null),
                networkRx: point(previous.series5m.networkRx, sample.network.reported ? sample.network.rxBps : null),
                networkTx: point(previous.series5m.networkTx, sample.network.reported ? sample.network.txBps : null),
            },
        }, now);
    }
    return result;
}

export function isMachineResourceStateStale(state: MachineResourceState, now: number): boolean {
    const sample = state.snapshot?.sample;
    return sample !== null && sample !== undefined && now - sample.sampledAt >= sample.intervalMs * 2;
}

export function createMachineResourceStore(clients: MachineResourceClients, nowMs: () => number = Date.now) {
    const unsupported = new Set<string>();
    const daemonVersions = new Map<string, number | null | undefined>();
    const markUnsupported = (input: MachineResourceKey) => {
        unsupported.add(machineKey(input));
        store.publish({ ...input, view: 'summary' }, { kind: 'not_reported' });
        store.publish({ ...input, view: 'overview' }, { kind: 'not_reported' });
    };
    const store = createSharedSubscriptionStore<
        MachineResourceStoreInput, MachineResourceState, ResourceUpdate,
        MachineResourceClients['snapshotClient'], MachineResourceClients['watchClient']
    >({
        emptyState: EMPTY_MACHINE_RESOURCE_STATE, createState: () => EMPTY_MACHINE_RESOURCE_STATE,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null }),
        storeKey: input => JSON.stringify([machineKey(input), input.view]),
        defaultSnapshotClient: clients.snapshotClient, defaultWatchClient: clients.watchClient,
        retainState: true, watchAfterRefresh: true,
        shouldWatch: state => state.status === 'ready' && state.snapshot?.state === 'reporting',
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineResourceState> => {
            if (unsupported.has(machineKey(input))) return retain(state, { ...state, status: 'not_reported' });
            if (!daemonVersions.has(machineKey(input))) daemonVersions.set(machineKey(input), input.daemonStateVersion);
            const result = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = getHeldState(input);
            if (result.ok) {
                if (result.value.sample && current.snapshot?.sample && result.value.sample.sampledAt < current.snapshot.sample.sampledAt) return current;
                if (result.value.state === 'reporting' && result.value.sample) {
                    store.publish({ ...input, view: input.view === 'overview' ? 'summary' : 'overview' },
                        { kind: 'samples', samples: [result.value.sample], retainDetails: true });
                }
                return applySnapshot(current, result.value, nowMs());
            }
            if (result.reason === 'older_happier') markUnsupported(input);
            return applyUpdate(current, { kind: result.reason === 'older_happier' ? 'not_reported' : 'error',
                ...(result.errorCode ? { errorCode: result.errorCode } : {}) }, nowMs());
        },
        failRefresh: (_state, input) => applyUpdate(getHeldState(input), { kind: 'error' }, nowMs()),
        applySnapshot: (state, update) => applyUpdate(state, update, nowMs()),
        watch: async ({ input, state, watchClient, signal }) => {
            if (unsupported.has(machineKey(input))) return { status: 'unavailable' };
            const result = await watchClient({ ...input,
                ...(state.snapshot?.sample ? { sinceSampledAt: state.snapshot.sample.sampledAt } : {}), signal });
            if (signal?.aborted) return { status: 'unavailable' };
            if (!result.ok) {
                if (result.reason === 'older_happier') markUnsupported(input);
                else store.publish(input, { kind: 'error', ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
                return { status: 'unavailable' };
            }
            if (result.value.changed) {
                store.publish({ ...input, view: input.view === 'overview' ? 'summary' : 'overview' },
                    { kind: 'samples', samples: result.value.samples, retainDetails: true });
                const previousAt = state.snapshot?.sample?.sampledAt ?? 0;
                const newestAt = result.value.samples.reduce((latest, sample) => Math.max(latest, sample.sampledAt), previousAt);
                if (input.view === 'overview' && Math.floor(newestAt / 60_000) > Math.floor(previousAt / 60_000)) {
                    // History buckets and today totals are daemon-owned; only demanded ranges refresh.
                    for (const range of ['1h', '24h', '7d'] as const) histories.invalidate({ ...input, range });
                }
            }
            if (!result.value.changed) store.publish(input, { kind: 'freshness' });
            return result.value.changed ? { status: 'changed', snapshot: { kind: 'samples', samples: result.value.samples } } : { status: 'idle' };
        },
    });
    const histories = createSharedSubscriptionStore<HistoryInput, MachineResourceHistoryState, MachineVitalsHistoryV1, MachineResourceClients['historyClient']>({
        emptyState: EMPTY_MACHINE_RESOURCE_HISTORY_STATE, createState: () => EMPTY_MACHINE_RESOURCE_HISTORY_STATE,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null }),
        storeKey: input => JSON.stringify([machineKey(input), input.range]),
        defaultSnapshotClient: clients.historyClient, retainState: true,
        refresh: async ({ input, state, snapshotClient, signal }) => {
            if (unsupported.has(machineKey(input))) return NOT_REPORTED_HISTORY_STATE;
            if (!daemonVersions.has(machineKey(input))) daemonVersions.set(machineKey(input), input.daemonStateVersion);
            const result = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            if (result.ok) return retain(state, { status: 'ready', history: retain(state.history, result.value) });
            if (result.reason === 'older_happier') markUnsupported(input);
            const { errorCode: _previousErrorCode, ...retained } = state;
            return retain(state, { ...retained, status: result.reason === 'older_happier' ? 'not_reported' : 'error',
                ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
        },
        failRefresh: state => {
            const { errorCode: _previousErrorCode, ...retained } = state;
            return retain(state, { ...retained, status: 'error' });
        },
        applySnapshot: (state, history) => retain(state, { status: 'ready', history: retain(state.history, history) }),
    });
    function getHeldState(input: MachineResourceStoreInput): MachineResourceState {
        if (unsupported.has(machineKey(input))) return NOT_REPORTED_STATE;
        const state = store.getState(input);
        if (state.snapshot?.sample) return state;
        // Views demand different detail, but the same machine's held base sample is still valid
        // when an offline Overview has never opened. Reads retain it on failure as well.
        const held = store.getState({ ...input, view: input.view === 'overview' ? 'summary' : 'overview' });
        return held.snapshot?.sample ? held : state;
    }
    return {
        getState: getHeldState,
        observe(input: MachineResourceStoreInput, listener: () => void) {
            const release = store.observe(input, listener);
            const releaseHeld = store.observe({ ...input, view: input.view === 'overview' ? 'summary' : 'overview' }, listener);
            return () => { release(); releaseHeld(); };
        },
        setPublishedAttention(input: MachineResourceKey, attention: MachineResourceAttentionV1) {
            for (const view of ['summary', 'overview'] as const) store.publish({ ...input, view }, { kind: 'published_attention', attention });
        },
        demand(input: MachineResourceStoreInput, listener: () => void = () => {}) {
            return store.subscribe(input, listener, { nowMs });
        },
        read(input: MachineResourceStoreInput) { return store.read(input, { nowMs }); },
        warm(input: MachineResourceKey) {
            return store.readOnce({ ...input, view: 'summary' }, { nowMs });
        },
        retry(input: MachineResourceStoreInput) { store.invalidate(input); return store.read(input, { nowMs }); },
        getHistory(input: HistoryInput): MachineResourceHistoryState {
            return unsupported.has(machineKey(input)) ? NOT_REPORTED_HISTORY_STATE : histories.getState(input);
        },
        observeHistory: histories.observe,
        demandHistory(input: HistoryInput, listener: () => void = () => {}) { return histories.subscribe(input, listener, { nowMs }); },
        readHistory(input: HistoryInput) { return histories.read(input, { nowMs }); },
        retryHistory(input: HistoryInput) { histories.invalidate(input); return histories.read(input, { nowMs }); },
        daemonStateChanged(input: MachineResourceKey, version: number | null | undefined) {
            const key = machineKey(input);
            if (daemonVersions.has(key) && daemonVersions.get(key) === version) return;
            daemonVersions.set(key, version);
            const wasUnsupported = unsupported.delete(key);
            for (const view of ['summary', 'overview'] as const) {
                const state = store.getState({ ...input, view });
                if (wasUnsupported || state.status === 'error' || state.stale || state.snapshot?.state === 'unavailable') {
                    store.invalidate({ ...input, view });
                }
            }
            if (wasUnsupported) {
                for (const range of ['1h', '24h', '7d'] as const) histories.invalidate({ ...input, range });
            }
        },
        reset() { store.reset(); histories.reset(); unsupported.clear(); daemonVersions.clear(); },
    };
}

export type MachineResourceStore = ReturnType<typeof createMachineResourceStore>;
export const machineResourceStore = createMachineResourceStore({
    snapshotClient: async input => (await import('./machineRpc')).fetchMachineVitalsViaMachineRpc(input),
    watchClient: async input => (await import('./machineRpc')).watchMachineVitalsViaMachineRpc(input),
    historyClient: async input => (await import('./machineRpc')).fetchMachineVitalsHistoryViaMachineRpc(input),
});
