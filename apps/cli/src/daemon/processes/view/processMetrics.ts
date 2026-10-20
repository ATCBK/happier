import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { createCounterRateReader } from '@/daemon/vitals/readers/counterRates';
import { processRef } from './processRef';

/** The approved detail chart window, not a sample-count limit. */
export const MACHINE_PROCESS_HISTORY_WINDOW_MS = 60 * 60_000;
export type ProcessMetricSample = Readonly<{ capturedAtMs: number; memoryBytes: number | null; cpuPercent?: number | null }>;
export type ProcessMetrics = Readonly<{ ref: string; memoryBytes: number | null; cpuPercent?: number }>;

export function createProcessMetrics() {
    const rates = new Map<string, ReturnType<typeof createCounterRateReader>>();
    const histories = new Map<string, ProcessMetricSample[]>();
    function append(key: string, sample: ProcessMetricSample, intervalMs: number) {
        const history = histories.get(key) ?? [];
        const previousAt = history.at(-1)?.capturedAtMs;
        if (previousAt !== undefined && sample.capturedAtMs <= previousAt) return;
        const oldest = sample.capturedAtMs - MACHINE_PROCESS_HISTORY_WINDOW_MS;
        histories.set(key, [...history.filter(sample => sample.capturedAtMs >= oldest),
            ...(previousAt !== undefined && sample.capturedAtMs - previousAt > intervalMs * 2 && previousAt + intervalMs >= oldest
                ? [{ capturedAtMs: previousAt + intervalMs, memoryBytes: null, cpuPercent: null }] : []), sample]);
    }
    return {
        observe(snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>, intervalMs: number,
            owners: ReadonlyMap<string, ReadonlyMap<number, string>> = new Map()): ReadonlyMap<number, ProcessMetrics> {
            const alive = new Set<string>();
            const result = new Map<number, ProcessMetrics>();
            for (const row of snapshot.rows) {
                if (result.has(row.pid)) continue;
                const ref = processRef(row.pid, row.start);
                alive.add(ref);
                const reader = rates.get(ref) ?? createCounterRateReader();
                rates.set(ref, reader);
                const rate = row.cpuTimeUs === null ? null : reader({ monotonicMs: snapshot.capturedAtMs, counters: { cpu: row.cpuTimeUs } }, intervalMs);
                const cpuPercent = rate && snapshot.logicalCpus > 0
                    ? Math.min(100, rate.deltas.cpu / (rate.elapsedMs * 1000 * snapshot.logicalCpus) * 100) : undefined;
                const metric = { ref, memoryBytes: row.memory?.bytes ?? null, ...(cpuPercent === undefined ? {} : { cpuPercent }) };
                result.set(row.pid, metric);
                append(ref, { capturedAtMs: snapshot.capturedAtMs, memoryBytes: metric.memoryBytes, ...(cpuPercent === undefined ? {} : { cpuPercent }) }, intervalMs);
            }
            for (const [key, refs] of owners) {
                const members = [...refs].map(([pid, ref]) => {
                    const metric = result.get(pid);
                    return metric?.ref === ref ? metric : undefined;
                });
                if (!members.length) continue;
                const memoryBytes = members.some(member => !member || member.memoryBytes === null) ? null
                    : members.reduce((sum, member) => sum + member!.memoryBytes!, 0);
                const cpuPercent = members.some(member => member?.cpuPercent === undefined) ? undefined
                    : Math.min(100, members.reduce((sum, member) => sum + member!.cpuPercent!, 0));
                append(key, { capturedAtMs: snapshot.capturedAtMs, memoryBytes, ...(cpuPercent === undefined ? {} : { cpuPercent }) }, intervalMs);
                alive.add(key);
            }
            for (const key of rates.keys()) if (!alive.has(key)) { rates.delete(key); histories.delete(key); }
            for (const key of histories.keys()) if (!alive.has(key)) histories.delete(key);
            return result;
        },
        history(): Readonly<Record<string, readonly ProcessMetricSample[]>> { return Object.fromEntries(histories); },
        reset() { rates.clear(); histories.clear(); },
    };
}
