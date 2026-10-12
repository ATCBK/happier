import type { ProcessCensusSnapshot, ProcessStartIdentity } from './processCensus';

export function createProcessCpuSampler() {
  let previousAtMs: number | null = null;
  let previousRows = new Map<number, { start: ProcessStartIdentity; cpuTimeUs: number }>();
  return { sample(snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>): ReadonlyMap<number, number> {
    const rates = new Map<number, number>();
    const wallTimeMs = previousAtMs === null ? 0 : snapshot.capturedAtMs - previousAtMs;
    if (wallTimeMs > 0 && snapshot.logicalCpus > 0) {
      for (const row of snapshot.rows) {
        const before = previousRows.get(row.pid);
        if (!before || row.cpuTimeUs === null
          || before.start.startTimeMs !== row.start.startTimeMs
          || before.start.native !== row.start.native) continue;
        const deltaUs = row.cpuTimeUs - before.cpuTimeUs;
        if (deltaUs < 0) continue;
        rates.set(row.pid, Math.min(100, deltaUs / (wallTimeMs * 1000 * snapshot.logicalCpus) * 100));
      }
    }
    // A missing row or counter breaks its baseline; a PID is not a generation.
    previousAtMs = snapshot.capturedAtMs;
    previousRows = new Map(snapshot.rows.flatMap(row => row.cpuTimeUs === null ? []
      : [[row.pid, { start: row.start, cpuTimeUs: row.cpuTimeUs }] as const]));
    return rates;
  } };
}
