import type { ProcessCensusSnapshot, ProcessStartIdentity } from './processCensus';
import { createCounterRateReader } from '@/daemon/vitals/readers/counterRates';

export function createProcessCpuSampler() {
  const readers = new Map<number, { start: ProcessStartIdentity; rate: ReturnType<typeof createCounterRateReader> }>();
  return { sample(snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>, intervalMs: number): ReadonlyMap<number, number> {
    const rates = new Map<number, number>();
    const observed = new Set<number>();
    for (const row of snapshot.rows) {
      if (observed.has(row.pid)) continue;
      observed.add(row.pid);
      if (row.cpuTimeUs === null) { readers.delete(row.pid); continue; }
      const before = readers.get(row.pid);
      const reader = before && before.start.startTimeMs === row.start.startTimeMs && before.start.native === row.start.native
        ? before : { start: row.start, rate: createCounterRateReader() };
      readers.set(row.pid, reader);
      const rate = reader.rate({ monotonicMs: snapshot.capturedAtMs, counters: { cpu: row.cpuTimeUs } }, intervalMs);
      if (rate && rate.elapsedMs > 0 && snapshot.logicalCpus > 0)
        rates.set(row.pid, Math.min(100, rate.deltas.cpu / (rate.elapsedMs * 1000 * snapshot.logicalCpus) * 100));
    }
    for (const pid of readers.keys()) if (!observed.has(pid)) readers.delete(pid);
    return rates;
  } };
}
