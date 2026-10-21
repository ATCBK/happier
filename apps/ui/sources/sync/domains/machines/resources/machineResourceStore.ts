import type { MachineVitalsSnapshotV1, MachineVitalsWatchResultV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import type { MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { projectMachineResourceSummaryV1, type MachineResourceSummaryV1, type MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';

import { createSharedSubscriptionStore, type SharedSubscriptionWatchOutcome } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import type {
    MachineResourceKey, MachineVitalsView, MachineVitalsRange, MachineResourceRpcResult,
    MachineVitalsReadInput, MachineVitalsHistoryReadInput, MachineVitalsWatchInput,
} from './machineRpc';

export type MachineResourceState = Readonly<{
    status: 'loading' | 'ready' | 'slow' | 'error' | 'not_reported';
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
    | Readonly<{ kind: 'slow' | 'error' | 'not_reported'; errorCode?: string }>;
type HistoryInput = MachineResourceKey & Readonly<{ range: MachineVitalsRange }>;

function machineKey(input: MachineResourceKey): string { return JSON.stringify([input.serverId ?? null, input.expectedAccountId ?? null, input.machineId]); }
/** Reconcile admitted resource data, stopping at shared branches rather than serializing them. */
function retain<T>(previous: T, next: T): T {
    if (previous === next) return previous;
    if (previous === null || next === null || typeof previous !== 'object' || typeof next !== 'object') return next;
    if (Array.isArray(previous) || Array.isArray(next)) {
        if (!Array.isArray(previous) || !Array.isArray(next)) return next;
        const retained = next.map((value: unknown, index: number) => retain(previous[index], value));
        return previous.length === retained.length && retained.every((value, index) => value === previous[index])
            ? previous : retained as T;
    }
    const old = previous as Record<string, unknown>;
    const incoming = next as Record<string, unknown>;
    // Optional undefined fields and omitted fields carry the same admitted resource fact.
    const keys = Object.keys(incoming).filter(key => incoming[key] !== undefined);
    const retained: Record<string, unknown> = { ...incoming };
    let unchanged = keys.length === Object.keys(old).filter(key => old[key] !== undefined).length;
    for (const key of keys) {
        retained[key] = retain(old[key], incoming[key]);
        if (retained[key] !== old[key]) unchanged = false;
    }
    return unchanged ? previous : retained as T;
}

/** Children have already been reconciled; a changed live tail must never be deep-walked here. */
function retainState<T extends object>(previous: T, next: T): T {
    const keys = Object.keys(next) as (keyof T)[];
    return keys.every(key => previous[key] === next[key])
        && (Object.keys(previous) as (keyof T)[]).every(key => previous[key] === next[key]) ? previous : next;
}

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

/** The machine's always-on history resolution (VIT-1/VIT-4): one record stands for one minute. */
const MINUTE_RECORD_MS = 60_000;

function retainSeries(previous: MachineVitalsSnapshotV1['series5m'] | undefined, next: MachineVitalsSnapshotV1['series5m'], sampledAt: number): MachineVitalsSnapshotV1['series5m'] {
    // R7's five-minute view has twenty slots, independent of the Overview's live cadence.
    const stepMs: MachineResourceSummaryV1['stepMs'] = 15_000;
    const end = Math.floor(sampledAt / stepMs) * stepMs;
    const start = end - 300_000 + stepMs;
    const points = (old: typeof next.cpu, incoming: typeof next.cpu) => {
        const byTime = new Map(old.map(point => [point.t, point]));
        const byStep = new Map<number, typeof incoming[number]>();
        for (const point of incoming) {
            if (point.t < start || point.t > sampledAt) continue;
            const at = Math.floor(point.t / stepMs) * stepMs;
            // Keep the first observation in a slot: live ticks cannot redraw an unchanged line.
            if (!byStep.has(at)) byStep.set(at, point);
        }
        const retained: typeof next.cpu = [];
        const first = byStep.size > 0 ? Math.min(...byStep.keys()) : end + stepMs;
        let covering: typeof incoming[number] | undefined;
        for (let at = first; at <= end; at += stepMs) {
            // A minute record stands for its whole minute, so it fills the slots up to the next observation: the
            // machine declares a missed minute or a stalled ring as an explicit null (VIT-4), and only that is a
            // gap. Past a minute with nothing observed the slot is a gap too; nothing is interpolated.
            const observed = byStep.get(at);
            if (observed) covering = observed;
            const measured = covering && covering.y !== null && at < covering.t + MINUTE_RECORD_MS ? covering : null;
            const point = measured ?? { t: at, y: null };
            const existing = byTime.get(point.t);
            retained.push(existing && existing.y === point.y ? existing : point);
        }
        return retain(old, retained);
    };
    const series = {
        cpu: points(previous?.cpu ?? [], next.cpu), memory: points(previous?.memory ?? [], next.memory),
        networkRx: points(previous?.networkRx ?? [], next.networkRx), networkTx: points(previous?.networkTx ?? [], next.networkTx),
    };
    return previous ? retain(previous, series) : series;
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
    const series5m = sample ? retainSeries(previous?.series5m, incoming.series5m, sample.sampledAt) : incoming.series5m;
    const snapshot = previous ? retain(previous, {
        ...incoming, sample,
        series5m,
        ...(incoming.attention ? { attention: retain(previous.attention, incoming.attention) } : {}),
    }) : { ...incoming, sample, series5m };
    const projected = projectMachineResourceSummaryV1(snapshot);
    const summary = state.summary && projected ? retain(state.summary, {
        ...projected,
        // Missing samples stay gaps in history; the figure keeps the last measurement.
        cpu: retain(state.summary.cpu, { ...projected.cpu, busyPct: projected.cpu.busyPct ?? state.summary.cpu.busyPct }),
        memory: retain(state.summary.memory, { ...projected.memory, series: retain(state.summary.memory.series, projected.memory.series) }),
        disk: retain(state.summary.disk, projected.disk), network: retain(state.summary.network, projected.network),
    }) : projected;
    const next: MachineResourceState = { status: 'ready', snapshot, summary, stale: false, samples: sample ? appendSamples(state.samples, [sample]) : state.samples };
    return retainState(state, { ...next, stale: isMachineResourceStateStale(next, now) });
}

function applyUpdate(state: MachineResourceState, update: ResourceUpdate, now: number): MachineResourceState {
    if (update.kind === 'snapshot') return applySnapshot(state, update.snapshot, now);
    if (update.kind === 'freshness') {
        const stale = isMachineResourceStateStale(state, now);
        if (state.status === 'slow' || state.status === 'error') {
            const { errorCode: _previousErrorCode, ...retained } = state;
            return { ...retained, status: 'ready', stale };
        }
        return state.stale === stale ? state : { ...state, stale };
    }
    if (update.kind === 'published_attention') {
        if (!state.snapshot) return state;
        const attention = retain(state.snapshot.attention, update.attention);
        if (attention === state.snapshot.attention) return state;
        const reprojected = applySnapshot(state, { ...state.snapshot, attention }, now);
        return { ...reprojected, status: state.status, ...(state.errorCode ? { errorCode: state.errorCode } : {}) };
    }
    if (update.kind !== 'samples') {
        const { errorCode: _previousErrorCode, ...retained } = state;
        return retainState(state, { ...retained, status: update.kind, stale: isMachineResourceStateStale(state, now),
            ...(update.errorCode ? { errorCode: update.errorCode } : {}) });
    }
    if (!state.snapshot) return state;
    let result = state;
    for (const incoming of update.samples) {
        const previous = result.snapshot!;
        if (incoming.sampledAt < (previous.sample?.sampledAt ?? -1)) continue;
        if (incoming.sampledAt === previous.sample?.sampledAt && update.retainDetails) {
            // A successful sibling answer also recovers a failed read at the same sampler frontier.
            // It is not a new chart point, and must not discard this view's retained details.
            if (result.status !== 'ready' || previous.state !== 'reporting') {
                result = applySnapshot(result, { ...previous, state: 'reporting', reason: undefined }, now);
            }
            continue;
        }
        // Memory is one reader-owned observation, including its optional composition.
        // Only independent extras can outlive another view's newer sample.
        const sample = retainSample(previous.sample, update.retainDetails ? {
            ...previous.sample, ...incoming,
            ...(previous.sample?.limits?.inotify && !incoming.limits?.inotify
                ? { limits: { ...incoming.limits, inotify: previous.sample.limits.inotify } } : {}),
        } : incoming);
        if (sample.sampledAt === previous.sample?.sampledAt) {
            result = applySnapshot(result, { ...previous, state: 'reporting', reason: undefined, sample }, now);
            continue;
        }
        const last = previous.sample;
        // A live ring that skipped samples says so with one null, as the machine's own five-minute series does. A
        // cadence change (the minute tick speeding up when a list opens, the Overview's 2 s tick ending) is not a skip:
        // the slower of the two intervals sets what counts as one.
        const missed = last && sample.sampledAt - last.sampledAt > 2 * Math.max(last.intervalMs, sample.intervalMs)
            ? last.sampledAt + last.intervalMs : null;
        const point = (old: typeof previous.series5m.cpu, y: number | null) => [
            ...old,
            ...(missed !== null ? [{ t: missed, y: null }] : []),
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
        subscribeRecovery: subscribeMachineRpcRecovery,
        shouldWatch: state => (state.status === 'ready' || state.status === 'slow'
            || (state.status === 'error' && state.errorCode === MACHINE_RPC_TIMEOUT_ERROR_CODE)) && state.snapshot?.state === 'reporting',
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineResourceState> => {
            if (unsupported.has(machineKey(input))) return retainState(state, { ...state, status: 'not_reported' });
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
        onWatchSnapshot: (input, update, previous) => {
            if (update.kind !== 'samples') return;
            store.publish({ ...input, view: input.view === 'overview' ? 'summary' : 'overview' },
                { ...update, retainDetails: true });
            const previousAt = previous.snapshot?.sample?.sampledAt ?? 0;
            const newestAt = update.samples.reduce((latest, sample) => Math.max(latest, sample.sampledAt), previousAt);
            if (input.view === 'overview' && Math.floor(newestAt / 60_000) > Math.floor(previousAt / 60_000)) {
                // History buckets and today totals are daemon-owned; only demanded ranges refresh.
                for (const range of ['1h', '24h', '7d'] as const) histories.invalidate({ ...input, range });
            }
        },
        watch: ({ input, state, watchClient, signal }) => {
            let markDispatched!: () => void;
            const dispatched = new Promise<void>(resolve => { markDispatched = resolve; });
            const outcome = (async (): Promise<SharedSubscriptionWatchOutcome<ResourceUpdate>> => {
                if (unsupported.has(machineKey(input))) return { status: 'unavailable' };
                const result = await watchClient({ ...input,
                    ...(state.snapshot?.sample ? { sinceSampledAt: state.snapshot.sample.sampledAt } : {}), signal, onDispatched: markDispatched })
                    .catch(() => ({ ok: false, reason: 'request_failed' } as const));
                if (signal?.aborted) return { status: 'unavailable' };
                if (!result.ok) {
                    if (result.reason === 'older_happier') {
                        markUnsupported(input);
                        return { status: 'unavailable' };
                    }
                    const current = getHeldState(input);
                    const kind = current.status === 'slow' || current.status === 'error' ? 'error' : 'slow';
                    const update: ResourceUpdate = { kind, ...('errorCode' in result && result.errorCode ? { errorCode: result.errorCode } : {}) };
                    // The state predicate owns re-arming: deadlines keep their existing
                    // transport cadence, other failures await recovery or explicit Retry.
                    // A failed reply is not a successful publication/recovery wake.
                    return { status: 'changed', snapshot: update };
                }
                return { status: 'changed', snapshot: result.value.changed
                    ? { kind: 'samples', samples: result.value.samples } : { kind: 'freshness' } };
            })();
            // Failure/cancellation before dispatch must also release publication; the existing
            // transport deadline and demand lifecycle remain the recovery boundaries.
            void outcome.then(markDispatched, markDispatched);
            return { dispatched, outcome };
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
            if (result.ok) return retainState(state, { status: 'ready', history: retain(state.history, result.value) });
            if (result.reason === 'older_happier') markUnsupported(input);
            const { errorCode: _previousErrorCode, ...retained } = state;
            return retainState(state, { ...retained, status: result.reason === 'older_happier' ? 'not_reported' : 'error',
                ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
        },
        failRefresh: state => {
            const { errorCode: _previousErrorCode, ...retained } = state;
            return retainState(state, { ...retained, status: 'error' });
        },
        applySnapshot: (state, history) => retainState(state, { status: 'ready', history: retain(state.history, history) }),
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
