import { cpus, loadavg, uptime } from 'node:os';
import { readdir } from 'node:fs/promises';
import type { MachineVitalsHostFactsV1, MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { createProcessCustodySamplingInvoker, resolveProcessCustodySupportExecutable, type ProcessCustodyExecFile } from '@/subprocess/supervision/processCustody';
import { createCounterRateReader } from './counterRates';
import { NativeVitalsSampleSchema, type NativeVitalsSample } from './nativeSample';
import type { MachineVitalsReader } from './types';

export interface NativeMachineVitalsReaderOptions {
    signal?: AbortSignal;
    executablePath?: string | null;
    execFile?: ProcessCustodyExecFile;
    readCpuTimes?: () => NonNullable<NativeVitalsSample['cpu']>;
    readLoadAverage?: () => number[];
    readUptime?: () => number;
}
export function createNativeMachineVitalsReader(platform: 'darwin' | 'win32', options: NativeMachineVitalsReaderOptions = {}): MachineVitalsReader {
    const invoke = createProcessCustodySamplingInvoker({ execFile: options.execFile,
        resolveExecutable: () => options.executablePath === undefined ? resolveProcessCustodySupportExecutable(platform) : options.executablePath });
    const cpuDelta = createCounterRateReader();
    const networkDelta = createCounterRateReader();
    const swapDelta = createCounterRateReader();
    let host: MachineVitalsHostFactsV1 | undefined;
    let extrasAt = -Infinity;
    let extras: { composition?: NativeVitalsSample['memory']['composition']; battery?: MachineVitalsSampleV1['battery'] } = {};
    return { read: async (input) => {
        const readExtras = input.overviewExtras && input.monotonicMs - extrasAt >= 15_000;
        const outcome = await invoke({ command: 'vitals-sample', sampledAt: input.sampledAt, args: readExtras ? ['--extras'] : [], signal: options.signal });
        if (outcome.state !== 'ready') return outcome;
        let raw: NativeVitalsSample;
        try { raw = NativeVitalsSampleSchema.parse(JSON.parse(outcome.stdout)).sample; } catch { return { state: 'unavailable', reason: 'reader_failed' }; }
        if (raw.memory.availableBytes > raw.memory.totalBytes || raw.memory.totalBytes === 0) return { state: 'unavailable', reason: 'reader_failed' };
        const cpu = platform === 'darwin' ? (options.readCpuTimes ?? (() => cpus().map(({ times }) => ({ user: times.user + times.nice, system: times.sys + times.irq, idle: times.idle }))))() : raw.cpu;
        if (!cpu?.length) return { state: 'unavailable', reason: 'reader_failed' };
        const counters = cpu.flatMap((core) => [core.user, core.system, core.idle]);
        const delta = cpuDelta({ monotonicMs: input.monotonicMs, counters: Object.fromEntries(counters.map((value, index) => [String(index), value])) }, input.intervalMs);
        const cpuTotal = counters.reduce((sum, value) => sum + value, 0);
        const cpuBusy = cpu.reduce((sum, core) => sum + core.user + core.system, 0);
        const pct = (part: number, total: number) => total > 0 ? Math.round(Math.min(100, Math.max(0, part / total * 100)) * 10) / 10 : null;
        const summed = (remainder: number) => delta ? Object.entries(delta.deltas).reduce((sum, [key, value]) => sum + (Number(key) % 3 === remainder ? value : 0), 0) : 0;
        const totalDelta = delta ? Object.values(delta.deltas).reduce((sum, value) => sum + value, 0) : 0;
        const perCore = cpu.map((_, index) => delta ? pct(delta.deltas[index * 3] + delta.deltas[index * 3 + 1], delta.deltas[index * 3] + delta.deltas[index * 3 + 1] + delta.deltas[index * 3 + 2]) : null);
        const interfaces = [...raw.interfaces].sort((a, b) => a.id.localeCompare(b.id));
        const networkCounters = Object.fromEntries(interfaces.flatMap((iface, index) => [[String(index * 2), iface.rxBytes], [String(index * 2 + 1), iface.txBytes], [`id:${iface.id}:${iface.included}`, 0]]));
        const nd = networkDelta({ monotonicMs: input.monotonicMs, counters: networkCounters }, input.intervalMs);
        const networkInterfaces = interfaces.map((iface, index) => ({ id: iface.id, label: iface.name, included: iface.included,
            rxBps: nd ? nd.deltas[index * 2] * 1000 / nd.elapsedMs : null, txBps: nd ? nd.deltas[index * 2 + 1] * 1000 / nd.elapsedMs : null }));
        const included = interfaces.filter((iface) => iface.included);
        const rxBytes = included.reduce((sum, iface) => sum + iface.rxBytes, 0);
        const txBytes = included.reduce((sum, iface) => sum + iface.txBytes, 0);
        const rates = networkInterfaces.filter((iface) => iface.included);
        const busiest = nd ? [...rates].sort((a, b) => (b.rxBps ?? 0) + (b.txBps ?? 0) - (a.rxBps ?? 0) - (a.txBps ?? 0))[0] : undefined;
        const swap = raw.memory.swap;
        const sd = swap?.in !== undefined && swap.out !== undefined ? swapDelta({ monotonicMs: input.monotonicMs, counters: { in: swap.in, out: swap.out } }, input.intervalMs) : null;
        if (readExtras) { extrasAt = input.monotonicMs; extras = { composition: raw.memory.composition, battery: raw.battery }; }
        const usedBytes = raw.memory.totalBytes - raw.memory.availableBytes;
        let composition: NativeVitalsSample['memory']['composition'];
        if (input.overviewExtras && extras.composition) {
            let remainder = usedBytes;
            const segments = extras.composition.filter((segment) => segment.kind !== 'apps').map((segment) => {
                const bytes = Math.min(remainder, segment.bytes);
                remainder -= bytes;
                return { kind: segment.kind, bytes };
            });
            composition = [{ kind: 'apps', bytes: remainder }, ...segments];
        }
        const load = platform === 'darwin' ? (options.readLoadAverage ?? loadavg)().map((value) => value / cpu.length) : undefined;
        const sample: MachineVitalsSampleV1 = {
            v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
            cpu: { reported: true, busyPct: delta ? pct(summed(0) + summed(1), totalDelta) : null, perCore,
                userPct: delta ? pct(summed(0), totalDelta) : null, systemPct: delta ? pct(summed(1), totalDelta) : null,
                ...(raw.clusters?.length === cpu.length ? { clusters: raw.clusters } : {}), ...(load ? { load1: load[0], load5: load[1], load15: load[2] } : {}) },
            memory: { reported: true, totalBytes: raw.memory.totalBytes, availableBytes: raw.memory.availableBytes, usedBytes: raw.memory.totalBytes - raw.memory.availableBytes,
                pressure: { level: raw.memory.pressureLevel, source: raw.memory.pressureSource },
                ...(raw.memory.lowMemorySignal !== undefined ? { lowMemorySignal: raw.memory.lowMemorySignal } : {}),
                ...(swap ? { swap: { kind: swap.kind, totalBytes: swap.totalBytes, usedBytes: swap.usedBytes, swapping: sd ? Object.values(sd.deltas).some((value) => value > 0) : false },
                    ...(swap.kind === 'page_file' ? { commitUsedBytes: swap.usedBytes, commitLimitBytes: swap.totalBytes } : {}) } : {}),
                ...(composition ? { composition } : {}) },
            disk: { reported: true, volumes: raw.volumes },
            network: { reported: true, rxBps: nd ? rates.reduce((sum, iface) => sum + (iface.rxBps ?? 0), 0) : null, txBps: nd ? rates.reduce((sum, iface) => sum + (iface.txBps ?? 0), 0) : null,
                interfaces: networkInterfaces, ...(busiest ? { label: busiest.label } : {}) },
            ...(raw.limits ? { limits: raw.limits } : {}),
            ...(raw.power ? { power: raw.power } : {}),
            ...(input.overviewExtras && extras.battery ? { battery: extras.battery } : {}),
        };
        if (platform === 'darwin' && raw.daemonFileSoftLimit !== undefined) {
            try {
                const descriptors = await readdir('/dev/fd');
                sample.limits = { ...sample.limits, daemonFiles: { used: descriptors.length, max: raw.daemonFileSoftLimit } };
            } catch { /* Unavailable descriptor enumeration remains absent. */ }
        }
        host ??= { logicalCores: cpu.length, memoryTotalBytes: raw.memory.totalBytes, bootedAt: Math.max(0, Math.floor((input.sampledAt - (options.readUptime ?? uptime)() * 1000) / 1000) * 1000),
            ...(raw.performanceCores !== undefined ? { performanceCores: raw.performanceCores } : {}), ...(raw.efficiencyCores !== undefined ? { efficiencyCores: raw.efficiencyCores } : {}) };
        return { state: 'reporting', sample, host, minuteCounters: { monotonicMs: input.monotonicMs, cpu: { busy: cpuBusy, total: cpuTotal },
            network: { interfaceIds: included.map((iface) => iface.id), rxBytes, txBytes }, ...(swap?.in !== undefined && swap.out !== undefined ? { swap: { in: swap.in, out: swap.out } } : {}) } };
    } };
}
