import type { MachineVitalsHistoryV1, MachineVitalsHostFactsV1, MachineVitalsMinuteRecordV1, MachineVitalsSampleV1 } from '@happier-dev/protocol';
import { effectiveMachineMemoryPressureV1 } from '@happier-dev/protocol/machines/vitals/effectiveMachineMemoryPressureV1';
import type { MachineResourcesPolicyV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { MachineVitalsHistoryPointV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';

import { logger } from '@/ui/logger';

import { downsampleMachineVitalsHistory } from './history/downsample';
import type { MinuteHistoryStore } from './history/minuteHistoryStore';
import { createCounterRateReader } from './readers/counterRates';
import type { MachineVitalsMinuteCountersV1, MachineVitalsReader, MachineVitalsReaderResult } from './readers/types';

const MINUTE_MS = 60_000;
const SUMMARY_MS = 15_000;
export const MACHINE_VITALS_LIVE_INTERVAL_MS = 2_000;
const HOUR_MS = 60 * MINUTE_MS;

type TimerHandle = Readonly<{ unref?: () => void }>;
type SampleEvent = Readonly<{ sample: MachineVitalsSampleV1; minute?: MachineVitalsMinuteRecordV1 }>;

export type MachineVitalsSamplerState = { state: 'reporting' } | Extract<MachineVitalsReaderResult, { state: 'unavailable' }>;
export interface MachineVitalsSamplerOptions {
    readers: MachineVitalsReader;
    historyStore: MinuteHistoryStore;
    nowMs?: () => number;
    monotonicMs?: () => number;
    setTimeoutFn?: (callback: () => void, delayMs: number) => TimerHandle;
    clearTimeoutFn?: (handle: TimerHandle) => void;
    onError?: (error: unknown) => void;
    onStateChange?: (state: MachineVitalsSamplerState) => void;
    readPolicy?: () => MachineResourcesPolicyV1 | null;
    /** Completed reads, including repeated failures; consumers reuse the sampler clock. */
    onTick?: () => void;
}

export interface MachineVitalsSampler {
    start(): Promise<void>;
    stop(): Promise<void>;
    latest(): MachineVitalsSampleV1 | null;
    host(): MachineVitalsHostFactsV1 | null;
    state(): MachineVitalsSamplerState;
    subscribe(listener: (event: SampleEvent) => void): () => void;
    demand(view: 'summary' | 'live'): () => void;
    demandOverview(): () => void;
    minutes(sinceMs: number): readonly MachineVitalsMinuteRecordV1[];
    samplesSince(cursor: number, view?: 'summary' | 'overview'): readonly MachineVitalsSampleV1[];
    history(range: MachineVitalsHistoryV1['range']): MachineVitalsHistoryV1;
}

export function createMachineVitalsSampler(input: MachineVitalsSamplerOptions): MachineVitalsSampler {
    const nowMs = input.nowMs ?? Date.now;
    const monotonicMs = input.monotonicMs ?? (() => performance.now());
    const onError = input.onError ?? ((error: unknown) => logger.debug('[machine vitals] sampling failed', error));
    // The daemon's real clock is Node's; shared UI ambient types also declare a numeric browser timer.
    const setTimeoutFn = input.setTimeoutFn ?? ((callback, delayMs) => {
        const schedule: (callback: () => void, delayMs: number) => NodeJS.Timeout = globalThis.setTimeout;
        return schedule(callback, delayMs);
    });
    const clearTimeoutFn = input.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    const listeners = new Set<(event: SampleEvent) => void>();
    const ring: MachineVitalsSampleV1[] = [];
    let currentState: MachineVitalsSamplerState = { state: 'reporting' };
    let latest: MachineVitalsSampleV1 | null = null;
    let host: MachineVitalsHostFactsV1 | null = null;
    let timer: TimerHandle | null = null;
    let reading: Promise<void> | null = null;
    let lastReadStartedAt: number | null = null;
    let running = false;
    let summaries = 0;
    let lives = 0;
    let overviews = 0;
    let nextExtrasAt: number | null = null;
    let extrasSample: MachineVitalsSampleV1 | null = null;
    let cpuCounterDelta = createCounterRateReader();
    let networkCounterDelta = createCounterRateReader();
    let boundaryAt: number | null = null;
    let lastBucketMinute: number | null = null;
    let bucket: MachineVitalsSampleV1[] = [];

    const cadence = () => currentState.state === 'unavailable' && currentState.reason === 'helper_failing'
        ? MINUTE_MS : lives > 0 || overviews > 0 ? MACHINE_VITALS_LIVE_INTERVAL_MS : summaries > 0 ? SUMMARY_MS : MINUTE_MS;

    const changeState = (state: MachineVitalsSamplerState) => {
        if (state.state === currentState.state && (state.state === 'reporting'
            || (currentState.state === 'unavailable' && state.reason === currentState.reason))) return;
        currentState = state;
        input.onStateChange?.(state);
    };

    function schedule(immediateExtras = false): void {
        if (timer) clearTimeoutFn(timer);
        timer = null;
        if (!running || reading) return;
        const now = nowMs();
        const nextMinute = (Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS;
        const interval = cadence();
        // Read time and a watch's re-arm count toward the nominal start-to-start cadence.
        const nextCadence = immediateExtras && interval !== MINUTE_MS ? now
            : interval === MINUTE_MS ? nextMinute : Math.min(Math.max(now, (lastReadStartedAt ?? now) + interval), nextMinute);
        const next = overviews > 0 && nextExtrasAt !== null && interval !== MINUTE_MS
            ? Math.min(nextCadence, nextExtrasAt) : nextCadence;
        timer = setTimeoutFn(() => {
            timer = null;
            void sample(next === nextMinute ? nextMinute : undefined);
        }, Math.max(0, next - now));
        timer.unref?.();
    }

    function minuteRecord(t: number, counters: MachineVitalsMinuteCountersV1): MachineVitalsMinuteRecordV1 {
        const validMinute = boundaryAt === t - MINUTE_MS;
        const cpuReading: Record<string, number> = counters.containerCpu
            ? { [`usage:${counters.containerCpu.effectiveCores}`]: counters.containerCpu.usageUsec }
            : counters.cpu ? { busy: counters.cpu.busy, total: counters.cpu.total } : {};
        const networkIdentity = counters.network?.interfaceIds.slice().sort().join('\0');
        const networkReading: Record<string, number> = counters.network
            ? { [`rx:${networkIdentity}`]: counters.network.rxBytes, [`tx:${networkIdentity}`]: counters.network.txBytes } : {};
        const cpuDelta = cpuCounterDelta({ monotonicMs: counters.monotonicMs, counters: cpuReading }, MINUTE_MS);
        const networkDelta = networkCounterDelta({ monotonicMs: counters.monotonicMs, counters: networkReading }, MINUTE_MS);
        let cpu: number | null = null;
        let rx: number | null = null;
        let tx: number | null = null;
        if (validMinute) {
            if (cpuDelta && counters.containerCpu && counters.containerCpu.effectiveCores > 0) {
                cpu = Math.min(100, cpuDelta.deltas[`usage:${counters.containerCpu.effectiveCores}`]
                    / (cpuDelta.elapsedMs * 1000 * counters.containerCpu.effectiveCores) * 100);
            } else if (cpuDelta && counters.cpu && cpuDelta.deltas.total > 0) {
                cpu = Math.min(100, cpuDelta.deltas.busy / cpuDelta.deltas.total * 100);
            }
            if (networkDelta && counters.network) {
                // History stores a minute's rate in byte units. A late boundary's
                // actual counter span must not become an inflated per-minute rate.
                rx = networkDelta.deltas[`rx:${networkIdentity}`] * MINUTE_MS / networkDelta.elapsedMs;
                tx = networkDelta.deltas[`tx:${networkIdentity}`] * MINUTE_MS / networkDelta.elapsedMs;
            }
        }
        boundaryAt = t;
        const memories = bucket.flatMap((point) => point.memory.reported ? [point.memory] : []);
        const cpus = bucket.flatMap((point) => point.cpu.reported && point.cpu.busyPct !== null ? [point.cpu.busyPct] : []);
        const pressure = ['not_reported', 'calm', 'elevated', 'critical'] as const;
        const lvl = memories.reduce<MachineVitalsMinuteRecordV1['lvl']>((level, memory) =>
            pressure.indexOf(effectiveMachineMemoryPressureV1(memory)) > pressure.indexOf(level)
                ? effectiveMachineMemoryPressureV1(memory) : level, 'not_reported');
        const swaps = memories.flatMap((memory) => memory.swap ? [memory.swap.usedBytes] : []);
        return {
            t, cpu, cpuMax: cpus.length || cpu !== null ? Math.max(...cpus, cpu ?? 0) : null,
            mem: memories.length ? memories.reduce((sum, memory) => sum + memory.usedBytes, 0) / memories.length : null,
            memMax: memories.length ? Math.max(...memories.map((memory) => memory.usedBytes)) : null,
            lvl, swp: swaps.length ? Math.max(...swaps) : null, rx, tx,
        };
    }

    function preserveExtras(sample: MachineVitalsSampleV1, readExtras: boolean): MachineVitalsSampleV1 {
        if (readExtras) extrasSample = sample;
        if (!overviews || !extrasSample || readExtras) return sample;
        return {
            ...sample,
            ...(extrasSample.gpu ? { gpu: extrasSample.gpu } : {}),
            ...(extrasSample.battery ? { battery: extrasSample.battery } : {}),
            ...(extrasSample.thermal ? { thermal: extrasSample.thermal } : {}),
            ...(extrasSample.sharedMemory ? { sharedMemory: extrasSample.sharedMemory } : {}),
            ...(extrasSample.limits?.inotify ? { limits: { ...sample.limits, inotify: extrasSample.limits.inotify } } : {}),
        };
    }

    function sample(boundary?: number): Promise<void> {
        if (reading) return reading;
        const run = async () => {
            const sampledAt = nowMs();
            lastReadStartedAt = sampledAt;
            const observedBoundary = boundary === undefined ? undefined : Math.floor(sampledAt / MINUTE_MS) * MINUTE_MS;
            const intervalMs = cadence();
            const readExtras = overviews > 0 && (nextExtrasAt === null || sampledAt >= nextExtrasAt);
            let result: MachineVitalsReaderResult;
            try {
                const policy = input.readPolicy?.();
                // Whole-disk scans consume AC for worker sizing as well as scheduled
                // admission. Maintenance remains the sole owner of due times.
                const power = overviews > 0 || policy?.guard.keepAwake === 'on_power'
                    || policy?.storage.wholeDiskEnabled === true;
                result = await input.readers.read({ sampledAt, monotonicMs: monotonicMs(), intervalMs, overview: overviews > 0, power, overviewExtras: readExtras });
            } catch (error) {
                onError(error);
                result = { state: 'unavailable', reason: 'reader_failed' };
            }
            if (result.state === 'unavailable') {
                changeState(result);
                if (observedBoundary !== undefined) {
                    bucket = [];
                    lastBucketMinute = observedBoundary / MINUTE_MS;
                    cpuCounterDelta = createCounterRateReader();
                    networkCounterDelta = createCounterRateReader();
                    boundaryAt = null;
                }
                return;
            }
            changeState({ state: 'reporting' });
            if (readExtras) nextExtrasAt = sampledAt + SUMMARY_MS;
            const point = preserveExtras(result.sample, readExtras);
            const firstReading = latest === null;
            if (latest && sampledAt < latest.sampledAt) return;
            latest = point;
            host = result.host;
            if (ring.length && sampledAt - ring[ring.length - 1].sampledAt < MACHINE_VITALS_LIVE_INTERVAL_MS) ring[ring.length - 1] = point;
            else ring.push(point);
            while (ring.length && ring[0].sampledAt <= sampledAt - HOUR_MS) ring.shift();
            const currentMinute = Math.floor((observedBoundary ?? sampledAt) / MINUTE_MS);
            if (lastBucketMinute !== null && currentMinute > lastBucketMinute + 1) bucket = [];
            let minute: MachineVitalsMinuteRecordV1 | undefined;
            const isBoundary = observedBoundary !== undefined;
            if (isBoundary && firstReading) {
                // The first boundary establishes the baseline; it cannot report a preceding minute.
                minuteRecord(observedBoundary, result.minuteCounters);
            } else {
                bucket.push(point);
                if (isBoundary) {
                    const record = minuteRecord(observedBoundary, result.minuteCounters);
                    if (await input.historyStore.append(record)) minute = record;
                    bucket = [];
                }
            }
            lastBucketMinute = currentMinute;
            for (const listener of listeners) listener({ sample: point, ...(minute ? { minute } : {}) });
        };
        reading = run().catch(onError).finally(() => {
            reading = null;
            try { input.onTick?.(); } catch (error) { onError(error); }
            schedule(overviews > 0 && nextExtrasAt === null);
        });
        return reading;
    }

    function demand(view: 'summary' | 'live', overview = false): () => void {
        const previousCadence = cadence();
        if (overview) overviews++;
        else if (view === 'live') lives++;
        else summaries++;
        if (cadence() !== previousCadence || (overview && nextExtrasAt === null)) schedule(overview && nextExtrasAt === null);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const previousCadence = cadence();
            if (overview) overviews--;
            else if (view === 'live') lives--;
            else summaries--;
            if (cadence() !== previousCadence) schedule();
        };
    }

    return {
        start: (): Promise<void> => {
            if (running) return reading ?? Promise.resolve();
            running = true;
            const now = nowMs();
            return sample(now % MINUTE_MS === 0 ? now : undefined);
        },
        stop: async (): Promise<void> => {
            running = false;
            if (timer) clearTimeoutFn(timer);
            timer = null;
            await reading;
        },
        latest: (): MachineVitalsSampleV1 | null => latest,
        host: (): MachineVitalsHostFactsV1 | null => host,
        state: (): MachineVitalsSamplerState => currentState,
        subscribe: (listener: (event: SampleEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        demand,
        demandOverview: () => demand('live', true),
        minutes: (sinceMs: number) => input.historyStore.minutes(sinceMs),
        samplesSince: (cursor: number, view: 'summary' | 'overview' = 'overview'): readonly MachineVitalsSampleV1[] => {
            if (view === 'overview') return ring.filter((point) => point.sampledAt > cursor);
            let previous = cursor;
            return ring.filter((point) => {
                if (point.sampledAt <= cursor || point.sampledAt - previous < SUMMARY_MS) return false;
                previous = point.sampledAt;
                return true;
            });
        },
        history: (range: MachineVitalsHistoryV1['range']) => {
            const now = nowMs();
            const livePoints: MachineVitalsHistoryPointV1[] = ring.map((point) => ({
                t: point.sampledAt, cpu: point.cpu.reported ? point.cpu.busyPct : null,
                cpuMax: point.cpu.reported ? point.cpu.busyPct : null,
                mem: point.memory.reported ? point.memory.usedBytes : null,
                memMax: point.memory.reported ? point.memory.usedBytes : null,
                lvl: point.memory.reported ? point.memory.pressure.level : 'not_reported',
                swp: point.memory.reported && point.memory.swap ? point.memory.swap.usedBytes : null,
                rx: point.network.reported && point.network.rxBps !== null ? point.network.rxBps * point.intervalMs / 1000 : null,
                tx: point.network.reported && point.network.txBps !== null ? point.network.txBps * point.intervalMs / 1000 : null,
                ...(point.network.reported && point.network.rxBps !== null ? { rxObservedMs: point.intervalMs } : {}),
                ...(point.network.reported && point.network.txBps !== null ? { txObservedMs: point.intervalMs } : {}),
            }));
            return downsampleMachineVitalsHistory({ records: input.historyStore.minutes(now - 7 * 24 * HOUR_MS), range, now, livePoints });
        },
    };
}
