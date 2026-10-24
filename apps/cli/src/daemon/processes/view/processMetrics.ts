import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { createProcessCpuSampler } from '@/processes/census/processCpu';
import { MACHINE_PROCESS_HISTORY_WINDOW_MS } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { processRef } from './processRef';

export type ProcessMetricSample = Readonly<{ capturedAtMs: number; memoryBytes: number | null; cpuPercent?: number | null }>;
export type ProcessMetrics = Readonly<{ ref: string; memoryBytes: number | null; cpuPercent?: number;
    /** A targeted native observation could not validate retained ownership for this generation. */
    identityUnavailable?: true }>;

export function createProcessMetrics() {
    const cpu = createProcessCpuSampler();
    const histories = new Map<string, { samples: ProcessMetricSample[]; start: number; intervalMs: number }>();
    function append(key: string, sample: ProcessMetricSample, intervalMs: number) {
        const retained = histories.get(key) ?? { samples: [], start: 0, intervalMs };
        const history = retained.samples;
        const previousAt = history.at(-1)?.capturedAtMs;
        if (previousAt !== undefined && sample.capturedAtMs <= previousAt) return;
        retained.intervalMs = intervalMs;
        const oldest = sample.capturedAtMs - MACHINE_PROCESS_HISTORY_WINDOW_MS;
        while (retained.start < history.length && history[retained.start].capturedAtMs < oldest) retained.start++;
        // Compact only after the dead prefix matches the retained suffix: appends
        // stay amortized O(1), including after the hour-long window fills.
        if (retained.start > 0 && retained.start * 2 >= history.length) {
            history.splice(0, retained.start); retained.start = 0;
        }
        if (previousAt !== undefined && sample.capturedAtMs - previousAt > intervalMs * 2 && previousAt + intervalMs >= oldest)
            history.push({ capturedAtMs: previousAt + intervalMs, memoryBytes: null, cpuPercent: null });
        history.push(sample);
        histories.set(key, retained);
    }
    return {
        observe(snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>, intervalMs: number,
            owners: ReadonlyMap<string, ReadonlyMap<number, string>> = new Map(),
            identityUnavailable: ReadonlyMap<number, string> = new Map(), effectiveCores?: number): ReadonlyMap<number, ProcessMetrics> {
            const alive = new Set<string>();
            const result = new Map<number, ProcessMetrics>();
            const rates = cpu.sample(identityUnavailable.size
                ? { ...snapshot, rows: snapshot.rows.filter(row => !identityUnavailable.has(row.pid)) } : snapshot,
                intervalMs, effectiveCores);
            for (const row of snapshot.rows) {
                if (result.has(row.pid) || identityUnavailable.has(row.pid)) continue;
                const ref = processRef(row.pid, row.start);
                alive.add(ref);
                const cpuPercent = rates.get(row.pid);
                const metric = { ref, memoryBytes: row.memory?.bytes ?? null, ...(cpuPercent === undefined ? {} : { cpuPercent }) };
                result.set(row.pid, metric);
                append(ref, { capturedAtMs: snapshot.capturedAtMs, memoryBytes: metric.memoryBytes, ...(cpuPercent === undefined ? {} : { cpuPercent }) }, intervalMs);
            }
            for (const [pid, ref] of identityUnavailable) {
                alive.add(ref);
                result.set(pid, { ref, memoryBytes: null, identityUnavailable: true });
                append(ref, { capturedAtMs: snapshot.capturedAtMs, memoryBytes: null, cpuPercent: null }, intervalMs);
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
            for (const key of histories.keys()) if (!alive.has(key)) histories.delete(key);
            return result;
        },
        /** Every retained series; with `after`, only samples newer than it (a series may be empty), found from the tail. */
        history(after?: number, refs: Iterable<string> = histories.keys()): Readonly<Record<string, readonly ProcessMetricSample[]>> {
            return Object.fromEntries([...refs].flatMap(key => {
                const retained = histories.get(key);
                if (!retained) return [];
                const { samples, start } = retained;
                if (after === undefined) return [[key, start === 0 ? samples : samples.slice(start)]];
                let first = samples.length;
                while (first > start && samples[first - 1].capturedAtMs > after) first--;
                const delta = samples.slice(first);
                // The client's cursor can outlive our idle baseline. Preserve
                // the same measured gap semantics across that expiration too.
                const gapAt = after + retained.intervalMs;
                if (first === start && delta.length && delta[0].capturedAtMs - after > retained.intervalMs * 2
                    && gapAt >= samples[samples.length - 1].capturedAtMs - MACHINE_PROCESS_HISTORY_WINDOW_MS) {
                    delta.unshift({ capturedAtMs: gapAt, memoryBytes: null, cpuPercent: null });
                }
                return [[key, delta]];
            }));
        },
        reset() { cpu.reset(); histories.clear(); },
    };
}
