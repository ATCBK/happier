import { describe, expect, it } from 'vitest';
import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { createProcessMetrics } from './processMetrics';

function census(at: number, cpuTimeUs: number | null, native = 'linux-proc:12'): Extract<ProcessCensusSnapshot, { status: 'ok' }> {
    return { status: 'ok', capturedAtMs: at, logicalCpus: 4, rows: [{ pid: 20, ppid: 1, name: 'node',
        start: { startTimeMs: 12, native }, principal: { kind: 'uid', value: '1' },
        memory: { bytes: 200, kind: 'rss' }, cpuTimeUs }] };
}
describe('watched process metrics', () => {
    it('reports machine percent, keeps the baseline across close ticks and rejects reused generations and gaps', () => {
        const metrics = createProcessMetrics();
        expect(metrics.observe(census(1000, 0), 2000).get(20)?.cpuPercent).toBeUndefined();
        expect(metrics.observe(census(1100, 100_000), 2000).get(20)?.cpuPercent).toBeUndefined();
        expect(metrics.observe(census(3000, 2_000_000), 2000).get(20)?.cpuPercent).toBe(25);
        expect(metrics.observe(census(5000, 20_000_000), 2000).get(20)?.cpuPercent).toBe(100);
        expect(metrics.observe(census(7000, 21_000_000, 'linux-proc:13'), 2000).get(20)?.cpuPercent).toBeUndefined();
        expect(metrics.observe(census(12000, 23_000_000, 'linux-proc:13'), 2000).get(20)?.cpuPercent).toBeUndefined();
        expect(metrics.observe(census(14000, null, 'linux-proc:13'), 2000).get(20)?.memoryBytes).toBe(200);
        metrics.reset();
        expect(metrics.history()).toEqual({});
        expect(metrics.observe(census(16000, 24_000_000), 2000).get(20)?.cpuPercent).toBeUndefined();
    });
    it('keeps one hour of actual observations only and drops an exited process history', () => {
        const metrics = createProcessMetrics();
        metrics.observe(census(1000, 0), 2000);
        metrics.observe(census(3_604_001, 1), 2000);
        expect(Object.values(metrics.history())[0]).toEqual([{ capturedAtMs: 3_604_001, memoryBytes: 200 }]);
        metrics.observe({ ...census(3_606_001, 2), rows: [] }, 2000);
        expect(metrics.history()).toEqual({});
    });
    it('does not duplicate a same-snapshot observation and marks an unwatched gap', () => {
        const metrics = createProcessMetrics();
        metrics.observe(census(1000, 0), 2000);
        metrics.observe(census(1000, 0), 2000);
        metrics.observe(census(7000, 1_000_000), 2000);
        expect(Object.values(metrics.history())[0]).toEqual([
            { capturedAtMs: 1000, memoryBytes: 200 },
            { capturedAtMs: 3000, memoryBytes: null, cpuPercent: null },
            { capturedAtMs: 7000, memoryBytes: 200 },
        ]);
    });
});
