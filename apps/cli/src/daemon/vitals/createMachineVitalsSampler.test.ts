import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineVitalsSampler, type MachineVitalsSamplerOptions } from './createMachineVitalsSampler';
import { createMinuteHistoryStore } from './history/minuteHistoryStore';
import { createLinuxMachineVitalsReader } from './readers/linux';
import { createDarwinMachineVitalsReader } from './readers/darwin';
import type { ProcessCustodyExecFile } from '@/subprocess/supervision/processCustody';
import { createLinuxVitalsFixture } from './readers/linux.testkit';
import type { MachineVitalsReader } from './readers/types';
import { MachineVitalsSampleV1Schema, type MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { MachineVitalsHistoryV1Schema, MachineVitalsMinuteRecordV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';

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
                        composition: [{ kind: 'apps' as const, bytes: fixture.mem }] },
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

    it.each([0.5, 1, 2])('uses one effective container CPU capacity for live readings and minute history at quota %s', async (quota) => {
        const f = await createLinuxVitalsFixture();
        const historyStore = await createMinuteHistoryStore({ directory: join(directory, 'capacity-history'), nowMs: Date.now });
        await f.put('/proc/self/cgroup', '0::/child\n');
        await f.put('/proc/self/mountinfo', '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n');
        await f.put('/sys/fs/cgroup/child/cpu.max', `${quota * 100_000} 100000`);
        await f.put('/sys/fs/cgroup/child/cpu.stat', 'usage_usec 0\nuser_usec 0\nsystem_usec 0\nnr_throttled 0\n');
        const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: f.root }),
            historyStore, monotonicMs: () => Date.now() - initialTime });
        try {
            await sampler.start();
            const effectiveCores = Math.min(1, quota);
            await f.put('/sys/fs/cgroup/child/cpu.stat', `usage_usec ${effectiveCores * 60_000_000}\nuser_usec ${effectiveCores * 36_000_000}\nsystem_usec ${effectiveCores * 24_000_000}\nnr_throttled 1\n`);
            await vi.advanceTimersByTimeAsync(60_000);
            await sampler.start();
            expect(sampler.host()).toMatchObject({ logicalCores: 1, effectiveCores });
            expect(sampler.latest()?.cpu).toMatchObject({ busyPct: 100, userPct: 60, systemPct: 40, throttled: true });
            expect(sampler.minutes(initialTime)).toEqual([expect.objectContaining({ cpu: 100 })]);
        } finally { await sampler.stop(); await f.cleanup(); }
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
        await vi.advanceTimersByTimeAsync(1_000);
        await sampler.start();
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 2_000);
        expect(sampler.latest()?.memory).toHaveProperty('composition');
        expect(sampler.latest()).not.toHaveProperty('sharedMemory');
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
        await vi.advanceTimersByTimeAsync(55_000);
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 4_000);
        await vi.advanceTimersByTimeAsync(1_000);
        await sampler.start();
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 60_000);
        await sampler.stop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sampler.latest()?.sampledAt).toBe(initialTime + 60_000);
    });

    it.each(['idle', 'summary', 'processes', 'guard', 'overview', 'on_power', 'scheduled_scan', 'manual_scan', 'scan_disabled'] as const)('enforces the Darwin %s tool spawn budget', async (view) => {
        let usedBytes = 80_000;
        let wiredPages = 1;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command) => ({ stdout: command === '/helper'
            ? JSON.stringify({ v: 1, t: 'vitals-sample', sample: {
                memory: { totalBytes: 100_000, availableBytes: 100_000 - usedBytes, pressureLevel: 'calm', pressureSource: 'kernel_level' },
                volumes: [], interfaces: [],
            } }) : command === '/usr/bin/vm_stat'
                ? `Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages wired down: ${wiredPages}.\nPages occupied by compressor: 1.\nFile-backed pages: 1.\n`
                : command === '/usr/bin/pmset' ? "Now drawing from 'AC Power'\n" : '', stderr: '' }));
        const readers = createDarwinMachineVitalsReader({ executablePath: '/helper', execFile, readCpuTimes: () => [{ user: 1, system: 1, idle: 1 }] });
        const historyStore = await createMinuteHistoryStore({ directory: join(directory, 'darwin-history'), nowMs: Date.now });
        // A due scan is an enabled power-dependent policy even without a viewed tab.
        const at = new Date(initialTime);
        const scheduledTime = [at.getHours(), at.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
        let policy = MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { keepAwake: view === 'on_power' ? 'on_power' : 'off' },
            storage: { wholeDiskEnabled: view === 'scheduled_scan' || view === 'manual_scan', scheduledScan: view === 'scheduled_scan' || view === 'scan_disabled'
                ? { weekday: at.getDay(), time: scheduledTime, onlyOnPower: true } : null } });
        const needsPolicyPower = view === 'on_power' || view === 'scheduled_scan' || view === 'manual_scan';
        const sampler = createMachineVitalsSampler({ readers, historyStore, monotonicMs: () => Date.now() - initialTime, readPolicy: () => policy });
        const count = (command: string, arg?: string) => execFile.mock.calls.filter(([name, args]) => name === command && (arg === undefined || args[1] === arg)).length;
        await sampler.start();
        expect(count('/usr/bin/vm_stat')).toBe(0);
        expect(count('/usr/bin/pmset', 'batt')).toBe(needsPolicyPower ? 1 : 0);
        const release = view === 'overview' ? sampler.demandOverview()
            : view === 'processes' ? sampler.demand('live') : view === 'summary' || view === 'guard' ? sampler.demand('summary') : () => {};
        try {
            await vi.advanceTimersByTimeAsync(0);
            await sampler.start();
            // Two viewers still share the same read, including a simultaneous summary surface.
            const releaseSecond = view === 'overview' ? sampler.demandOverview() : () => {};
            const releaseSummary = view === 'overview' ? sampler.demand('summary') : () => {};
            for (let t = 2_000; t <= 14_000; t += 2_000) {
                usedBytes += 100;
                wiredPages++;
                await vi.advanceTimersByTimeAsync(2_000);
                await sampler.start();
                if (view === 'overview') {
                    const memory = sampler.latest()?.memory;
                    if (!memory?.reported) throw new Error('Memory unavailable');
                    expect(memory.usedBytes).toBe(usedBytes);
                    expect(memory.composition?.find((part) => part.kind === 'wired')?.bytes).toBe(wiredPages * 4_096);
                    expect(memory.composition?.reduce((sum, part) => sum + part.bytes, 0)).toBe(memory.usedBytes);
                }
            }
            expect(count('/usr/bin/vm_stat')).toBe(view === 'overview' ? 8 : 0);
            expect(count('/usr/bin/pmset', 'therm')).toBe(view === 'overview' ? 1 : 0);
            expect(count('/usr/bin/pmset', 'batt')).toBe(view === 'overview' || needsPolicyPower ? 1 : 0);
            expect(count('/usr/sbin/ioreg')).toBe(view === 'overview' ? 1 : 0);
            expect(count('/helper')).toBe(view === 'overview' ? 9 : view === 'processes' ? 8 : 1);
            await vi.advanceTimersByTimeAsync(1_000);
            await sampler.start();
            expect(count('/usr/bin/vm_stat')).toBe(view === 'overview' ? 9 : 0);
            expect(count('/usr/bin/pmset', 'therm')).toBe(view === 'overview' ? 2 : 0);
            expect(count('/usr/bin/pmset', 'batt')).toBe(view === 'overview' ? 2 : needsPolicyPower ? 1 : 0);
            expect(count('/usr/sbin/ioreg')).toBe(view === 'overview' ? 2 : 0);
            releaseSecond();
            releaseSummary();
            release();
            const vmRequests = count('/usr/bin/vm_stat');
            const releaseProcesses = sampler.demand('live');
            await vi.advanceTimersByTimeAsync(2_000);
            await sampler.start();
            expect(count('/usr/bin/vm_stat')).toBe(vmRequests);
            expect(sampler.latest()?.memory).not.toHaveProperty('composition');
            releaseProcesses();
            await vi.advanceTimersByTimeAsync(43_000);
            await sampler.start();
            expect(count('/usr/bin/pmset', 'batt')).toBe(needsPolicyPower || view === 'overview' ? 2 : 0);
            if (needsPolicyPower) expect(sampler.latest()?.power).toEqual({ onAC: true });
            policy = MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { keepAwake: 'on' } });
            const batteryReads = count('/usr/bin/pmset', 'batt');
            await vi.advanceTimersByTimeAsync(60_000);
            await sampler.start();
            expect(count('/usr/bin/pmset', 'batt')).toBe(batteryReads);
            expect(sampler.latest()?.power).toBeUndefined();
        } finally {
            release();
            await sampler.stop();
        }
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
        expect(sampler.minutes(initialTime)[0]).toMatchObject({ t: initialTime + 60_000, cpu: 50,
            rx: 500 * 60_000 / 60_005, tx: 200 * 60_000 / 60_005 });
        // A suspended process misses two minute boundaries; the old counters cannot explain a fresh minute.
        delay = 120_005;
        await writeCounters({ busy: 80, total: 200, rx: 1500, tx: 900 });
        await vi.advanceTimersByTimeAsync(59_995);
        await sampler.start();
        expect(sampler.minutes(initialTime)[1]).toMatchObject({ t: initialTime + 240_000, cpu: null, rx: null, tx: null });
        await sampler.stop();
    });

    it('keeps the live cadence anchored across slow OS reads and watch re-arms', async () => {
        const fixture = await createLinuxVitalsFixture();
        const store = await createMinuteHistoryStore({ directory: join(directory, 'slow-linux-history'), nowMs: Date.now });
        let delayed = false;
        let tick: (() => void) | undefined;
        const sampler = createMachineVitalsSampler({
            readers: createLinuxMachineVitalsReader({ root: fixture.root, statfs: async () => {
                // OS capacity enumeration consumes real sampling time, not a suspended timer.
                if (!delayed) { delayed = true; vi.setSystemTime(Date.now() + 3_000); }
                return { bsize: 4096, blocks: 1000, bfree: 500, bavail: 500, files: 100, ffree: 50 };
            } }),
            historyStore: store, monotonicMs: () => Date.now() - initialTime,
            onTick: () => tick?.(),
        });
        try {
            await sampler.start();
            const release = sampler.demand('live');
            await fixture.put('/proc/stat', 'cpu 110 30 40 450 70 0 0 10 0 0\ncpu0 110 30 40 450 70 0 0 10 0 0\nbtime 100\n');
            const sampled = new Promise<MachineVitalsSampleV1 | null>(resolve => { tick = () => resolve(sampler.latest()); });
            await vi.advanceTimersByTimeAsync(2_000);
            const firstLive = await sampled;
            expect(firstLive?.cpu).toMatchObject({ reported: true, busyPct: 30 });
            expect(firstLive?.sampledAt).toBe(initialTime + 3_000);
            expect(firstLive?.intervalMs).toBe(2_000);
            release();
        } finally {
            await sampler.stop();
            await fixture.cleanup();
        }
    });

    it.each([
        { name: 'extras after timer jitter', offset: 0, jitterAt: 14_000, duration: 18_000, rearmAt: Infinity },
        { name: 'the aligned minute', offset: 45_500, jitterAt: Infinity, duration: 16_500, rearmAt: Infinity },
        { name: 'a watch re-arm at the aligned minute', offset: 45_500, jitterAt: Infinity, duration: 18_500, rearmAt: 14_000 },
    ])('keeps valid live counter spans around $name', async ({ offset, jitterAt, duration, rearmAt }) => {
        vi.setSystemTime(initialTime + offset);
        const fixture = await createLinuxVitalsFixture();
        const historyStore = await createMinuteHistoryStore({ directory: join(directory, 'counter-spacing-history'), nowMs: Date.now });
        let jitter = 0;
        const writeOsCounters = async () => {
            const ticks = Math.floor((Date.now() + jitter - initialTime) / 10);
            await fixture.put('/proc/stat', `cpu ${1_000 + ticks} 0 0 ${5_000 + ticks} 0 0 0 0 0 0\ncpu0 ${1_000 + ticks} 0 0 ${5_000 + ticks} 0 0 0 0 0 0\nbtime 100\n`);
            await fixture.put('/proc/net/dev', `eth0: ${10_000 + ticks} 0 0 0 0 0 0 0 ${20_000 + ticks} 0 0 0 0 0 0 0\n`);
        };
        const observations: MachineVitalsSampleV1[] = [];
        const sampler = createMachineVitalsSampler({
            readers: createLinuxMachineVitalsReader({ root: fixture.root }), historyStore,
            nowMs: () => Date.now() + jitter,
            monotonicMs: () => Date.now() + jitter - initialTime,
            setTimeoutFn: (callback, delay) => setTimeout(() => {
                // Clock/OS timer boundary: one callback arrives 100 ms late.
                if (Date.now() >= initialTime + jitterAt) jitter = 100;
                callback();
            }, delay),
        });
        try {
            await writeOsCounters();
            await sampler.start();
            const releaseSummary = sampler.demand('summary');
            let release = sampler.demandOverview();
            const unsubscribe = sampler.subscribe(({ sample }) => observations.push(sample));
            for (let elapsed = 0; elapsed < duration; elapsed += 500) {
                // RPC demand ends when its answer resolves, before the next watch arrives.
                if (elapsed === rearmAt) release();
                if (elapsed === rearmAt + 1_000) release = sampler.demandOverview();
                await writeOsCounters();
                await vi.advanceTimersByTimeAsync(500);
                await sampler.start();
            }
            const ordinary = observations.filter(sample => sample.sampledAt >= initialTime + offset + 2_000);
            expect(ordinary.length).toBeGreaterThan(1);
            expect(ordinary.filter(sample => sample.cpu.reported && sample.cpu.busyPct === null).map(sample => sample.sampledAt - initialTime)).toEqual([]);
            expect(ordinary.filter(sample => sample.network.reported && (sample.network.rxBps === null || sample.network.txBps === null)).map(sample => sample.sampledAt - initialTime)).toEqual([]);
            if (offset > 0) expect(sampler.minutes(initialTime).at(-1)?.t).toBe(initialTime + 60_000);
            unsubscribe();
            release();
            releaseSummary();
        } finally { await sampler.stop(); await fixture.cleanup(); }
    });

    it('keeps each live memory composition with its own reading between extras reads and drops it for cgroup memory', async () => {
        const fixture = await createLinuxVitalsFixture();
        const historyStore = await createMinuteHistoryStore({ directory: join(directory, 'composition-history'), nowMs: Date.now });
        const sampler = createMachineVitalsSampler({
            readers: createLinuxMachineVitalsReader({ root: fixture.root }), historyStore,
            monotonicMs: () => Date.now() - initialTime,
        });
        try {
            await sampler.start();
            const release = sampler.demandOverview();
            await vi.advanceTimersByTimeAsync(0);
            await sampler.start();
            for (const available of [35_000, 30_000, 45_000]) {
                await fixture.put('/proc/meminfo', `MemTotal: 100000 kB\nMemAvailable: ${available} kB\nAnonPages: 20000 kB\nSlab: 2000 kB\nSReclaimable: 1000 kB\n`);
                await vi.advanceTimersByTimeAsync(2_000);
                await sampler.start();
                const memory = sampler.latest()!.memory;
                expect(memory.reported).toBe(true);
                if (!memory.reported) throw new Error('Expected measured memory');
                expect(memory.usedBytes).toBe((100_000 - available) * 1024);
                expect(memory.composition?.reduce((sum, part) => sum + part.bytes, 0)).toBe(memory.usedBytes);
                expect(MachineVitalsSampleV1Schema.parse(sampler.latest())).toEqual(sampler.latest());
            }
            // A cgroup working set cannot use a host-wide /proc/meminfo decomposition.
            await fixture.put('/proc/self/mountinfo', '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n');
            await fixture.put('/sys/fs/cgroup/memory.max', '50000000');
            await fixture.put('/sys/fs/cgroup/memory.current', '30000000');
            await fixture.put('/sys/fs/cgroup/memory.stat', 'inactive_file 10000000\n');
            await vi.advanceTimersByTimeAsync(2_000);
            await sampler.start();
            expect(sampler.latest()?.memory).toMatchObject({ limitSource: 'cgroup', usedBytes: 20_000_000 });
            expect(sampler.latest()?.memory).not.toHaveProperty('composition');
            release();
        } finally { await sampler.stop(); await fixture.cleanup(); }
    });

    it.each([4_600, 11_000])('journals honest rates through a %s ms re-arm, extras and minute frontiers', async (gap) => {
        const fixture = await createLinuxVitalsFixture();
        const historyDirectory = join(directory, 'honest-history');
        const historyStore = await createMinuteHistoryStore({ directory: historyDirectory, nowMs: Date.now });
        let pending: { at: number; callback: () => void } | null = null;
        const writeOsCounters = async () => {
            const t = Date.now() - initialTime;
            await fixture.put('/proc/stat', `cpu ${1_000 + t} 0 0 ${5_000 + t} 0 0 0 0 0 0\ncpu0 ${1_000 + t} 0 0 ${5_000 + t} 0 0 0 0 0 0\nbtime 100\n`);
            const excluded = t === 60_000 || t > 20_000 && t % 4_000 !== 0;
            await fixture.put('/proc/net/dev', `eth0: ${10_000 + t} 0 0 0 0 0 0 0 ${20_000 + t * 2} 0 0 0 0 0 0 0\n${excluded ? 'veth0: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n' : ''}`);
        };
        const sampler = createMachineVitalsSampler({
            readers: createLinuxMachineVitalsReader({ root: fixture.root }), historyStore,
            monotonicMs: () => Date.now() - initialTime,
            setTimeoutFn: (callback, delay) => { pending = { at: Date.now() + delay, callback }; return {}; },
            clearTimeoutFn: () => { pending = null; },
        });
        const fire = async () => {
            if (!pending) throw new Error('No sampler timer');
            const { at, callback } = pending;
            pending = null;
            vi.setSystemTime(at);
            await writeOsCounters();
            callback();
            await sampler.start();
        };
        const assertRate = () => expect(sampler.latest()).toMatchObject({ cpu: { busyPct: 50 }, network: { rxBps: 1_000, txBps: 2_000 } });
        let release = () => {};
        try {
            await writeOsCounters();
            await sampler.start();
            release = sampler.demand('live');
            await fire();
            assertRate();
            release();
            vi.setSystemTime(Date.now() + gap);
            release = sampler.demand('live');
            await fire();
            assertRate();
            release();
            release = sampler.demandOverview();
            await fire(); // First extras read can be at the same instant as the preceding reading.
            while (sampler.latest()!.sampledAt < initialTime + 120_000) {
                await fire();
                assertRate();
            }
            expect(sampler.minutes(initialTime)).toMatchObject([
                { t: initialTime + 60_000, cpu: 50, rx: 60_000, tx: 120_000 },
                { t: initialTime + 120_000, cpu: 50, rx: 60_000, tx: 120_000 },
            ]);
            const history = sampler.history('1h');
            expect(history.points.filter(point => point && point.t >= initialTime + 2_000)
                .every(point => point?.cpu === 50 && point.rx !== null && point.tx !== null)).toBe(true);
            const restored = await createMinuteHistoryStore({ directory: historyDirectory, nowMs: Date.now });
            expect(restored.minutes(initialTime)).toEqual(sampler.minutes(initialTime));
        } finally { release(); await sampler.stop(); await fixture.cleanup(); }
    });

    it.each(['decrease', 'counted_interface', 'expired'] as const)('preserves an honest journal gap after %s', async (change) => {
        const fixture = await createLinuxVitalsFixture();
        const historyStore = await createMinuteHistoryStore({ directory: join(directory, 'reset-history'), nowMs: Date.now });
        let elapsed = 0;
        const sampler = createMachineVitalsSampler({
            readers: createLinuxMachineVitalsReader({ root: fixture.root }), historyStore,
            nowMs: () => Date.now() + elapsed,
            monotonicMs: () => Date.now() + elapsed - initialTime,
        });
        try {
            await sampler.start();
            await fixture.put('/proc/stat', 'cpu 200 20 30 500 50 0 0 10 0 0\ncpu0 200 20 30 500 50 0 0 10 0 0\nbtime 100\n');
            await fixture.put('/proc/net/dev', 'eth0: 61000 0 0 0 0 0 0 0 62000 0 0 0 0 0 0 0\n');
            await vi.advanceTimersByTimeAsync(60_000);
            await sampler.start();
            expect(sampler.minutes(initialTime).at(-1)?.rx).toBe(60_000);
            const id = change === 'counted_interface' ? 'eth1' : 'eth0';
            const bytes = change === 'decrease' ? 1 : 121_000;
            if (change === 'expired') elapsed = 60_001;
            await fixture.put('/proc/net/dev', `${id}: ${bytes} 0 0 0 0 0 0 0 ${bytes} 0 0 0 0 0 0 0\n`);
            await vi.advanceTimersByTimeAsync(60_000);
            await sampler.start();
            expect(sampler.latest()?.network).toMatchObject({ rxBps: null, txBps: null });
            expect(sampler.minutes(initialTime).at(-1)).toMatchObject({ rx: null, tx: null });
        } finally { await sampler.stop(); await fixture.cleanup(); }
    });

    it('keeps minute-history network rates averaged over actual late-read spans', async () => {
        const fixture = await createLinuxVitalsFixture();
        const historyStore = await createMinuteHistoryStore({ directory: join(directory, 'late-history'), nowMs: Date.now });
        let lateness = 0;
        const sampler = createMachineVitalsSampler({
            readers: createLinuxMachineVitalsReader({ root: fixture.root }), historyStore,
            nowMs: () => Date.now() + lateness,
            monotonicMs: () => Date.now() + lateness - initialTime,
        });
        try {
            await sampler.start();
            lateness = 11_000;
            await fixture.put('/proc/net/dev', 'eth0: 72000 0 0 0 0 0 0 0 144000 0 0 0 0 0 0 0\n');
            await vi.advanceTimersByTimeAsync(60_000);
            await sampler.start();
            expect(sampler.latest()?.network).toMatchObject({ rxBps: 1_000, txBps: 2_000 });
            expect(sampler.minutes(initialTime).at(-1)).toMatchObject({ t: initialTime + 60_000, rx: 60_000, tx: 120_000 });
            const live = MachineVitalsHistoryV1Schema.parse(sampler.history('1h')).points.at(-1);
            expect(live).toMatchObject({ rx: 60_000, tx: 120_000, rxObservedMs: 60_000, txObservedMs: 60_000 });
            await fixture.put('/proc/net/dev', 'eth0: 121000 0 0 0 0 0 0 0 242000 0 0 0 0 0 0 0\n');
            await vi.advanceTimersByTimeAsync(49_000);
            await sampler.start();
            expect(sampler.minutes(initialTime).at(-1)).toMatchObject({ t: initialTime + 120_000, rx: 60_000, tx: 120_000 });
        } finally { await sampler.stop(); await fixture.cleanup(); }
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
            expect(MachineVitalsSampleV1Schema.parse(sampler.latest())).toEqual(sampler.latest());
            const serialized = await readFile(join(historyDirectory, 'minutes-2026-10-10.jsonl'), 'utf8');
            const persisted: unknown[] = serialized.trim().split('\n').map(line => JSON.parse(line));
            expect(persisted.map(record => MachineVitalsMinuteRecordV1Schema.parse(record))).toEqual(sampler.minutes(initialTime));
            await sampler.stop();
            const restored = await createMinuteHistoryStore({ directory: historyDirectory, nowMs: Date.now });
            expect(restored.minutes(initialTime)).toEqual(sampler.minutes(initialTime));
        } finally {
            await rm(fixture.root, { recursive: true, force: true });
        }
    });
});
