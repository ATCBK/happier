import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineVitalsSampler, type MachineVitalsSamplerOptions } from './createMachineVitalsSampler';
import { createMinuteHistoryStore } from './history/minuteHistoryStore';
import { createLinuxMachineVitalsReader } from './readers/linux';
import { createLinuxVitalsFixture } from './readers/linux.testkit';
import type { MachineVitalsReader } from './readers/types';

interface CounterFixture {
    busy: number;
    total: number;
    rx: number;
    tx: number;
    mem: number;
    cpuPct: number | null;
    interfaces?: string[];
    failure?: 'reader_failed' | 'helper_failing';
    lowMemorySignal?: boolean;
    commitUsedBytes?: number;
    commitLimitBytes?: number;
}

describe('createMachineVitalsSampler', () => {
    const initialTime = Date.UTC(2026, 9, 10);
    let directory: string;
    let fixturePath: string;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(initialTime);
        directory = await mkdtemp(join(tmpdir(), 'happier-vitals-sampler-'));
        fixturePath = join(directory, 'os-counters.json');
    });
    afterEach(async () => {
        vi.useRealTimers();
        await rm(directory, { recursive: true, force: true });
    });

    async function writeCounters(patch: Partial<CounterFixture> = {}) {
        await writeFile(fixturePath, JSON.stringify({ busy: 0, total: 0, rx: 0, tx: 0, mem: 100, cpuPct: null, ...patch } satisfies CounterFixture));
    }

    async function setup(options: Partial<Omit<MachineVitalsSamplerOptions, 'readers' | 'historyStore'>> = {}, readBoundary = () => readFile(fixturePath, 'utf8')) {
        // This fixture reader is a filesystem system boundary, with captured cumulative-counter vectors.
        const reader: MachineVitalsReader = { read: async (input) => {
            const fixture = JSON.parse(await readBoundary()) as CounterFixture;
            if (fixture.failure) return { state: 'unavailable', reason: fixture.failure };
            return {
                state: 'reporting',
                host: { logicalCores: 4, memoryTotalBytes: 1000, bootedAt: initialTime - 100_000 },
                sample: {
                    v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
                    ...(input.overviewExtras ? { sharedMemory: { totalBytes: 500, availableBytes: 400 } } : {}),
                    cpu: { reported: true, busyPct: fixture.cpuPct },
                    memory: { reported: true, totalBytes: 1000, availableBytes: 1000 - fixture.mem, usedBytes: fixture.mem,
                        pressure: fixture.lowMemorySignal !== undefined || fixture.commitLimitBytes !== undefined
                            ? { level: 'not_reported', source: 'none' } : { level: 'calm', source: 'events' },
                        ...(fixture.lowMemorySignal === undefined ? {} : { lowMemorySignal: fixture.lowMemorySignal }),
                        ...(fixture.commitUsedBytes === undefined ? {} : { commitUsedBytes: fixture.commitUsedBytes }),
                        ...(fixture.commitLimitBytes === undefined ? {} : { commitLimitBytes: fixture.commitLimitBytes }),
                        ...(input.overviewExtras ? { composition: [{ kind: 'apps' as const, bytes: fixture.mem }] } : {}) },
                    disk: { reported: false, reason: 'unavailable' },
                    network: { reported: true, rxBps: null, txBps: null },
                },
                minuteCounters: { monotonicMs: input.monotonicMs, cpu: { busy: fixture.busy, total: fixture.total },
                    network: { interfaceIds: fixture.interfaces ?? ['eth0'], rxBytes: fixture.rx, txBytes: fixture.tx } },
            };
        } };
        const historyStore = await createMinuteHistoryStore({ directory: join(directory, 'history'), nowMs: () => Date.now() });
        return createMachineVitalsSampler({ readers: reader, historyStore, monotonicMs: () => Date.now() - initialTime, ...options });
    }

    it('answers immediately and samples minute boundaries even with a 15-second viewer', async () => {
        await writeCounters();
        const sampler = await setup();
        await sampler.start();
        expect(sampler.latest()?.sampledAt).toBe(initialTime);
        const release = sampler.demand('summary');
        await writeCounters({ busy: 15, total: 100, rx: 150, tx: 50, cpuPct: 15, mem: 200 });
        await vi.advanceTimersByTimeAsync(15_000);
        await sampler.start();
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 15_000);
        await writeCounters({ busy: 60, total: 200, rx: 600, tx: 200, cpuPct: 90, mem: 300 });
        for (let step = 0; step < 3; step++) {
            await vi.advanceTimersByTimeAsync(15_000);
            await sampler.start();
        }
        expect(sampler.minutes(initialTime)).toEqual([expect.objectContaining({
            t: initialTime + 60_000, cpu: 30, cpuMax: 90, mem: 275, memMax: 300, rx: 600, tx: 200,
        })]);
        release();
        await sampler.stop();
    });

    it('records Windows low-memory and exhausted commit as Critical for the shared sustained rules', async () => {
        await writeCounters({ lowMemorySignal: true });
        const sampler = await setup();
        await sampler.start();
        await vi.advanceTimersByTimeAsync(60_000);
        await sampler.start();
        expect(sampler.minutes(initialTime).at(-1)?.lvl).toBe('critical');
        await writeCounters({ lowMemorySignal: false, commitUsedBytes: 1000, commitLimitBytes: 1000 });
        await vi.advanceTimersByTimeAsync(60_000);
        await sampler.start();
        expect(sampler.minutes(initialTime).at(-1)?.lvl).toBe('critical');
        await writeCounters({ lowMemorySignal: false, commitUsedBytes: 999, commitLimitBytes: 1000 });
        await vi.advanceTimersByTimeAsync(60_000);
        await sampler.start();
        expect(sampler.minutes(initialTime).at(-1)?.lvl).toBe('calm');
        await sampler.stop();
    });

    it('reschedules faster demand, keeps Overview extras exclusive, and releases back to the minute cadence', async () => {
        await writeCounters();
        const sampler = await setup();
        await sampler.start();
        await vi.advanceTimersByTimeAsync(1_000);
        const releaseLive = sampler.demand('live');
        await vi.advanceTimersByTimeAsync(2_000);
        await sampler.start();
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 3_000);
        expect(sampler.latest()?.memory).not.toHaveProperty('composition');
        const releaseOverview = sampler.demandOverview();
        await vi.advanceTimersByTimeAsync(0);
        await sampler.start();
        expect(sampler.latest()?.memory).toHaveProperty('composition');
        expect(sampler.latest()?.sharedMemory).toEqual({ totalBytes: 500, availableBytes: 400 });
        await vi.advanceTimersByTimeAsync(2_000);
        await sampler.start();
        expect(sampler.latest()?.sharedMemory).toEqual({ totalBytes: 500, availableBytes: 400 });
        releaseOverview();
        releaseLive();
        await vi.advanceTimersByTimeAsync(54_000);
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 5_000);
        await vi.advanceTimersByTimeAsync(1_000);
        await sampler.start();
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 60_000);
        await sampler.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 60_000);
    });

    it('backs helper failure off to the minute and keeps the previous good sample', async () => {
        await writeCounters();
        const sampler = await setup();
        await sampler.start();
        const release = sampler.demand('live');
        await writeCounters({ failure: 'helper_failing' });
        await vi.advanceTimersByTimeAsync(2_000);
        await sampler.start();
        expect(sampler.state()).toEqual({ state: 'unavailable', reason: 'helper_failing' });
        expect(sampler.latest()?.sampledAt).toBe(initialTime);
        await writeCounters({ busy: 60, total: 100, rx: 300, tx: 600 });
        await vi.advanceTimersByTimeAsync(57_000);
        expect(sampler.state()).toEqual({ state: 'unavailable', reason: 'helper_failing' });
        await vi.advanceTimersByTimeAsync(1_000);
        await sampler.start();
        expect(sampler.state()).toEqual({ state: 'reporting' });
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 60_000);
        release();
        await sampler.stop();
    });

    it('records unavailable minute rates after counter reset or an interface change, then recovers', async () => {
        await writeCounters({ busy: 200, total: 500, rx: 1000, tx: 500 });
        const sampler = await setup();
        await sampler.start();
        await writeCounters({ busy: 1, total: 100, rx: 100, tx: 100, interfaces: ['eth1'] });
        await vi.advanceTimersByTimeAsync(60_000);
        await sampler.start();
        expect(sampler.minutes(initialTime)[0]).toMatchObject({ cpu: null, rx: null, tx: null });
        await writeCounters({ busy: 51, total: 200, rx: 500, tx: 200, interfaces: ['eth1'] });
        await vi.advanceTimersByTimeAsync(60_000);
        await sampler.start();
        expect(sampler.minutes(initialTime)[1]).toMatchObject({ cpu: 50, rx: 400, tx: 100 });
        await sampler.stop();
    });

    it('keeps a pending OS read single flight and shutdown waits for it', async () => {
        await writeCounters();
        let finishRead!: () => void;
        const gate = new Promise<void>((resolve) => { finishRead = resolve; });
        let activeReads = 0;
        let maximumReads = 0;
        const sampler = await setup({}, async () => {
            activeReads++;
            maximumReads = Math.max(maximumReads, activeReads);
            await gate;
            const content = await readFile(fixturePath, 'utf8');
            activeReads--;
            return content;
        });
        const started = sampler.start();
        const release = sampler.demand('live');
        await vi.advanceTimersByTimeAsync(60_000);
        let stopped = false;
        const stopping = sampler.stop().then(() => { stopped = true; });
        expect(stopped).toBe(false);
        finishRead();
        await Promise.all([started, stopping]);
        expect(maximumReads).toBe(1);
        expect(sampler.latest()?.sampledAt).toBe(initialTime);
        expect(stopped).toBe(true);
        release();
    });

    it('journals the intended minute when a timer runs late and does not fabricate stale rates after sleep', async () => {
        await writeCounters();
        let delay = 0;
        const sampler = await setup({ nowMs: () => Date.now() + delay, monotonicMs: () => Date.now() + delay - initialTime });
        await sampler.start();
        await writeCounters({ busy: 50, total: 100, rx: 500, tx: 200 });
        delay = 5;
        await vi.advanceTimersByTimeAsync(60_000);
        await sampler.start();
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 60_005);
        expect(sampler.minutes(initialTime)[0]).toMatchObject({ t: initialTime + 60_000, cpu: 50, rx: 500, tx: 200 });
        // A suspended process misses two minute boundaries; the old counters cannot explain a fresh minute.
        delay = 120_005;
        await writeCounters({ busy: 80, total: 200, rx: 1500, tx: 900 });
        await vi.advanceTimersByTimeAsync(59_995);
        await sampler.start();
        expect(sampler.minutes(initialTime)[1]).toMatchObject({ t: initialTime + 240_000, cpu: null, rx: null, tx: null });
        await sampler.stop();
    });

    it('composes the real Linux reader and persistent minute journal', async () => {
        const fixture = await createLinuxVitalsFixture();
        try {
            const historyDirectory = join(directory, 'linux-history');
            const store = await createMinuteHistoryStore({ directory: historyDirectory, nowMs: Date.now });
            const sampler = createMachineVitalsSampler({
                readers: createLinuxMachineVitalsReader({ root: fixture.root }), historyStore: store,
                monotonicMs: () => Date.now() - initialTime,
            });
            await sampler.start();
            await fixture.put('/proc/stat', 'cpu 110 30 40 450 70 0 0 10 0 0\ncpu0 110 30 40 450 70 0 0 10 0 0\nbtime 100\n');
            await fixture.put('/proc/net/dev', 'eth0: 3000 0 0 0 0 0 0 0 6000 0 0 0 0 0 0 0\n');
            await vi.advanceTimersByTimeAsync(60_000);
            await sampler.start();
            expect(sampler.minutes(initialTime)[0]).toMatchObject({ cpu: 30, mem: 61_440_000, rx: 2000, tx: 4000 });
            await sampler.stop();
            const restored = await createMinuteHistoryStore({ directory: historyDirectory, nowMs: Date.now });
            expect(restored.minutes(initialTime)).toEqual(sampler.minutes(initialTime));
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });
});
