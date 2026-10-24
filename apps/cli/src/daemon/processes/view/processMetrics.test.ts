import { describe, expect, it } from 'vitest';
import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { createProcessMetrics } from './processMetrics';
import { processRef } from './processRef';

function census(at: number, cpuTimeUs: number | null, native = 'linux-proc:12'): Extract<ProcessCensusSnapshot, { status: 'ok' }> {
    return { status: 'ok', capturedAtMs: at, logicalCpus: 4, rows: [{ pid: 20, ppid: 1, name: 'node',
        start: { startTimeMs: 12, native }, principal: { kind: 'uid', value: '1' },
        memory: { bytes: 200, kind: 'rss' }, cpuTimeUs }] };
}
describe('watched process metrics', () => {
    it('uses the shared effective-capacity CPU rates and resets when capacity changes', () => {
        const metrics = createProcessMetrics();
        metrics.observe(census(1000, 0), 2000, undefined, undefined, 0.5);
        expect(metrics.observe(census(3000, 1_000_000), 2000, undefined, undefined, 0.5).get(20)?.cpuPercent).toBe(100);
        expect(metrics.observe(census(5000, 2_000_000), 2000, undefined, undefined, 2).get(20)?.cpuPercent).toBeUndefined();
        expect(metrics.observe(census(7000, 3_000_000), 2000, undefined, undefined, 2).get(20)?.cpuPercent).toBe(25);
    });

    it('gaps an unreadable counter and requires a new CPU baseline before recovery', () => {
        const metrics = createProcessMetrics();
        metrics.observe(census(1000, 0), 2000);
        expect(metrics.observe(census(3000, 2_000_000), 2000).get(20)?.cpuPercent).toBe(25);
        expect(metrics.observe(census(5000, null), 2000).get(20)?.cpuPercent).toBeUndefined();
        expect(metrics.observe(census(7000, 4_000_000), 2000).get(20)?.cpuPercent).toBeUndefined();
        expect(metrics.observe(census(9000, 6_000_000), 2000).get(20)?.cpuPercent).toBe(25);
    });

    it('keeps append storage stable for an hour-long baseline', () => {
        const metrics = createProcessMetrics();
        metrics.observe(census(1000, 0), 2000);
        const ref = processRef(20, census(1000, 0).rows[0].start);
        const baseline = metrics.history()[ref];
        for (let tick = 1; tick <= 1800; tick++) metrics.observe(census(1000 + tick * 2000, tick * 1000), 2000);
        expect(metrics.history()[ref] === baseline).toBe(true);
        expect(metrics.history()[ref]).toHaveLength(1801);
    });
    it('reads only the samples newer than a held cursor from the tail of a full hour', () => {
        const metrics = createProcessMetrics();
        const ref = processRef(20, census(1000, 0).rows[0].start);
        for (let tick = 0; tick <= 1800; tick++) metrics.observe(census(1000 + tick * 2000, tick * 1000), 2000);
        const newest = 1000 + 1800 * 2000;
        expect(metrics.history(newest - 4000)[ref].map(sample => sample.capturedAtMs)).toEqual([newest - 2000, newest]);
        expect(metrics.history(newest)[ref]).toEqual([]);
    });
    it('materializes only demanded owner/detail histories and keeps steady-state delta bytes independent of the retained hour', () => {
        const metrics = createProcessMetrics();
        const ref = processRef(20, census(1000, 0).rows[0].start);
        const owners = new Map([['session:s', new Map([[20, ref]])]]);
        for (let tick = 0; tick <= 1800; tick++) metrics.observe(census(1000 + tick * 2000, tick * 1000), 2000, owners);
        const newest = 1000 + 1800 * 2000;
        const full = metrics.history(undefined, ['session:s']);
        const delta = metrics.history(newest - 2000, ['session:s']);
        expect(Object.keys(full)).toEqual(['session:s']);
        expect(full['session:s']).toHaveLength(1801);
        expect(delta['session:s']).toHaveLength(1);
        expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(full).length / 1000);
        expect(metrics.history(newest - 2000, [ref])[ref]).toHaveLength(1);
    });
    it('marks the unwatched gap when a client cursor outlives the daemon baseline', () => {
        const metrics = createProcessMetrics();
        const ref = processRef(20, census(1000, 0).rows[0].start);
        metrics.observe(census(1000, 0), 2000);
        metrics.reset();
        metrics.observe(census(31000, 0), 2000);
        metrics.observe(census(33000, 2_000_000), 2000);
        expect(metrics.history(1000, [ref])[ref]).toEqual([
            { capturedAtMs: 3000, memoryBytes: null, cpuPercent: null },
            { capturedAtMs: 31000, memoryBytes: 200 },
            { capturedAtMs: 33000, memoryBytes: 200, cpuPercent: 25 },
        ]);
        expect(metrics.history()[ref]).toHaveLength(2);
    });
    it('gaps uncertain ownership resources and resets only that generation CPU baseline before recovery', () => {
        const metrics = createProcessMetrics();
        const sample = (at: number, cpu: number) => {
            const snapshot = census(at, cpu);
            return { ...snapshot, rows: [...snapshot.rows, { ...snapshot.rows[0], pid: 21 }] };
        };
        const ref = processRef(20, census(1000, 0).rows[0].start);
        const owners = new Map([['session:owner', new Map([[20, ref], [21, processRef(21, census(1000, 0).rows[0].start)]])]]);
        metrics.observe(sample(1000, 0), 2000, owners);
        expect(metrics.observe(sample(3000, 2_000_000), 2000, owners).get(20)?.cpuPercent).toBe(25);
        const uncertain = metrics.observe(sample(5000, 20_000_000), 2000, owners, new Map([[20, ref]]));
        expect(uncertain.get(20)).toMatchObject({ ref, memoryBytes: null, identityUnavailable: true });
        expect(uncertain.get(20)?.cpuPercent).toBeUndefined();
        expect(uncertain.get(21)?.cpuPercent).toBe(100);
        const recovered = metrics.observe(sample(7000, 22_000_000), 2000, owners);
        expect(recovered.get(20)?.cpuPercent).toBeUndefined();
        expect(recovered.get(21)?.cpuPercent).toBe(25);
        expect(metrics.observe(sample(9000, 24_000_000), 2000, owners).get(20)?.cpuPercent).toBe(25);
        expect(metrics.history()[ref].map(point => point.memoryBytes)).toEqual([200, 200, null, 200, 200]);
        expect(metrics.history()['session:owner'][2].memoryBytes).toBeNull();
    });
    it('does not aggregate a replacement generation into retained owner membership', () => {
        const metrics = createProcessMetrics();
        const owners = new Map([['session:old-owner', new Map([[20, processRef(20, census(1000, 0).rows[0].start)]])]]);
        metrics.observe(census(1000, 0), 2000, owners);
        metrics.observe(census(3000, 2_000_000), 2000, owners);
        const reused = census(5000, 50_000_000, 'linux-proc:13');
        metrics.observe({ ...reused, rows: reused.rows.map(row => ({ ...row, memory: { bytes: 999, kind: 'rss' } })) }, 2000, owners);
        expect(metrics.history()['session:old-owner']).toEqual([
            { capturedAtMs: 1000, memoryBytes: 200 },
            { capturedAtMs: 3000, memoryBytes: 200, cpuPercent: 25 },
            { capturedAtMs: 5000, memoryBytes: null },
        ]);
    });
    it('reports machine percent over the newest eligible observation and rejects reused generations', () => {
        const metrics = createProcessMetrics();
        expect(metrics.observe(census(1000, 0), 2000).get(20)?.cpuPercent).toBeUndefined();
        expect(metrics.observe(census(1100, 500_000), 2000).get(20)?.cpuPercent).toBeUndefined();
        // TA-20-6 retains the short observation: use its real 1.9 s span,
        // rather than the older 2 s span (which would report 25%).
        expect(metrics.observe(census(3000, 2_000_000), 2000).get(20)?.cpuPercent).toBeCloseTo(1_500_000 / (1900 * 1000 * 4) * 100);
        expect(metrics.observe(census(5000, 20_000_000), 2000).get(20)?.cpuPercent).toBe(100);
        expect(metrics.observe(census(7000, 21_000_000, 'linux-proc:13'), 2000).get(20)?.cpuPercent).toBeUndefined();
        expect(metrics.observe(census(12000, 23_000_000, 'linux-proc:13'), 2000).get(20)?.cpuPercent).toBe(10);
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
    it('does not duplicate a same-snapshot observation and marks an unwatched gap even when the returning CPU average is valid', () => {
        const metrics = createProcessMetrics();
        metrics.observe(census(1000, 0), 2000);
        metrics.observe(census(1000, 0), 2000);
        metrics.observe(census(7000, 1_000_000), 2000);
        expect(Object.values(metrics.history())[0]).toEqual([
            { capturedAtMs: 1000, memoryBytes: 200 },
            { capturedAtMs: 3000, memoryBytes: null, cpuPercent: null },
            { capturedAtMs: 7000, memoryBytes: 200, cpuPercent: 1_000_000 / (6000 * 1000 * 4) * 100 },
        ]);
    });
});
