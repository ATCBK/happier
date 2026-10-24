import type { ProcessCensusSnapshot, ProcessStartIdentity } from './processCensus';
import { createCounterRateReader } from '@/daemon/vitals/readers/counterRates';

export function createProcessCpuSampler() {
  const readers = new Map<number, { start: ProcessStartIdentity; capacity: number; rate: ReturnType<typeof createCounterRateReader> }>();
  return { sample(snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>, intervalMs: number,
    effectiveCores?: number): ReadonlyMap<number, number> {
    // Vitals owns quota-aware capacity. Before its first host read, use the census host capacity.
    const capacity = Math.min(snapshot.logicalCpus, effectiveCores !== undefined && effectiveCores > 0 ? effectiveCores : snapshot.logicalCpus);
    const rates = new Map<number, number>();
    const observed = new Set<number>();
    for (const row of snapshot.rows) {
      if (observed.has(row.pid)) continue;
      observed.add(row.pid);
      if (row.cpuTimeUs === null) { readers.delete(row.pid); continue; }
      const before = readers.get(row.pid);
      const reader = before && before.capacity === capacity
        && before.start.startTimeMs === row.start.startTimeMs && before.start.native === row.start.native
        ? before : { start: row.start, capacity, rate: createCounterRateReader() };
      readers.set(row.pid, reader);
      const rate = reader.rate({ monotonicMs: snapshot.capturedAtMs, counters: { cpu: row.cpuTimeUs } }, intervalMs);
      if (rate && rate.elapsedMs > 0 && capacity > 0)
        rates.set(row.pid, Math.min(100, rate.deltas.cpu / (rate.elapsedMs * 1000 * capacity) * 100));
    }
    for (const pid of readers.keys()) if (!observed.has(pid)) readers.delete(pid);
    return rates;
  }, reset() { readers.clear(); } };
}
