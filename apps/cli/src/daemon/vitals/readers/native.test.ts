import { describe, expect, it, vi } from 'vitest';
import { createWindowsMachineVitalsReader } from './windows';
import { createDarwinMachineVitalsReader } from './darwin';
import { type ProcessCustodyExecFile } from '@/subprocess/supervision/processCustody';

const output = (offset: number) => JSON.stringify({ v: 1, t: 'vitals-sample', sample: {
    cpu: [{ idle: 9000 + offset * 5, user: 3000 + offset * 3, system: 2000 + offset * 2 }],
    memory: { totalBytes: 32_000, availableBytes: 10_000, pressureLevel: 'not_reported', pressureSource: 'none', lowMemorySignal: true,
        swap: { kind: 'page_file', totalBytes: 64_000, usedBytes: 30_000 } },
    volumes: [{ id: 'volume-guid', label: 'System', mount: 'C:\\', totalBytes: 100_000, availableBytes: 50_000 }],
    interfaces: [{ id: '1', name: 'Ethernet', rxBytes: 8_000 + offset * 2, txBytes: 4_000 + offset, included: true },
        { id: '2', name: 'VPN', rxBytes: 900_000 + offset * 10, txBytes: 100_000 + offset * 10, included: false }],
} });

describe('native vitals reader contract', () => {
    it('reads macOS AC power on the canonical tick without exposing battery extras', async () => {
        let power = "Now drawing from 'AC Power'\n";
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command) => ({
            stdout: command === '/helper' ? output(0) : command === '/usr/bin/pmset' ? power : '', stderr: '',
        }));
        const reader = createDarwinMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 60_000, overviewExtras: false });
        expect(await read(0)).toMatchObject({ state: 'reporting', sample: { power: { onAC: true } } });
        power = "Now drawing from 'Battery Power'\n -InternalBattery-0 80%; discharging; 2:00 remaining\n";
        const result = await read(60_000);
        expect(result).toMatchObject({ state: 'reporting', sample: { power: { onAC: false } } });
        if (result.state === 'reporting') expect(result.sample.battery).toBeUndefined();
        power = '';
        const unknown = await read(120_000);
        if (unknown.state === 'reporting') expect(unknown.sample.power).toBeUndefined();
    });
    it.each([2_000, 15_000, 60_000])('shares the minute power observation at a %s ms base cadence', async (intervalMs) => {
        let power = "Now drawing from 'AC Power'\n";
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command) => ({
            stdout: command === '/helper' ? output(0) : command === '/usr/bin/pmset' ? power : '', stderr: '',
        }));
        const reader = createDarwinMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number, overviewExtras = false) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs, overviewExtras });
        for (let t = 0; t < 60_000; t += intervalMs) {
            expect(await read(t)).toMatchObject({ state: 'reporting', sample: { power: { onAC: true } } });
        }
        expect(execFile.mock.calls.filter(([command, args]) => command === '/usr/bin/pmset' && args[1] === 'batt')).toHaveLength(1);
        power = "Now drawing from 'Battery Power'\n -InternalBattery-0 80%; discharging; 2:00 remaining\n";
        expect(await read(60_000)).toMatchObject({ state: 'reporting', sample: { power: { onAC: false } } });
        expect(execFile.mock.calls.filter(([command, args]) => command === '/usr/bin/pmset' && args[1] === 'batt')).toHaveLength(2);
    });
    it('shares Overview battery reads with the existing extras cadence and reports the next power edge', async () => {
        let power = "Now drawing from 'AC Power'\n -InternalBattery-0 80%; charging; 1:00 remaining\n";
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async (command, args) => ({
            stdout: command === '/helper' ? output(0) : command === '/usr/bin/pmset' && args[1] === 'batt' ? power : '', stderr: '',
        }));
        const reader = createDarwinMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 2_000, overviewExtras: true });
        for (let t = 0; t < 16_000; t += 2_000) await read(t);
        expect(execFile.mock.calls.filter(([command, args]) => command === '/usr/bin/pmset' && args[1] === 'batt')).toHaveLength(1);
        power = "Now drawing from 'Battery Power'\n -InternalBattery-0 80%; discharging; 2:00 remaining\n";
        expect(await read(16_000)).toMatchObject({ state: 'reporting', sample: { power: { onAC: false }, battery: { state: 'discharging' } } });
        expect(execFile.mock.calls.filter(([command, args]) => command === '/usr/bin/pmset' && args[1] === 'batt')).toHaveLength(2);
    });
    it('projects fresh power edges without an Overview viewer', async () => {
        let onAC = true;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async () => {
            const raw = JSON.parse(output(0)); raw.sample.power = { onAC };
            return { stdout: JSON.stringify(raw), stderr: '' };
        });
        const reader = createWindowsMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 60_000, overviewExtras: false });
        expect(await read(0)).toMatchObject({ state: 'reporting', sample: { power: { onAC: true } } });
        onAC = false;
        expect(await read(60_000)).toMatchObject({ state: 'reporting', sample: { power: { onAC: false } } });
    });
    it('keeps Windows pressure unreported, projects commit charge, and derives rates only after a valid interval', async () => {
        let n = 0;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async () => ({ stdout: output(n++ * 100), stderr: '' }));
        const reader = createWindowsMachineVitalsReader({ executablePath: '/helper', execFile });
        const read = (t: number) => reader.read({ sampledAt: t, monotonicMs: t, intervalMs: 2000, overviewExtras: false });
        const first = await read(0);
        expect(first).toMatchObject({ state: 'reporting', sample: { cpu: { busyPct: null }, network: { rxBps: null }, memory: {
            pressure: { level: 'not_reported', source: 'none' }, lowMemorySignal: true, commitUsedBytes: 30_000, commitLimitBytes: 64_000,
        } } });
        expect(await read(2000)).toMatchObject({ state: 'reporting', sample: { cpu: { busyPct: 50, userPct: 30, systemPct: 20 }, network: { rxBps: 100, txBps: 50 } } });
        // A cadence change/sleep must not manufacture a large rate from an old baseline.
        expect(await read(20_000)).toMatchObject({ state: 'reporting', sample: { cpu: { busyPct: null }, network: { rxBps: null } } });
    });
    it('reports a missing helper without a spawn', async () => {
        const execFile = vi.fn<ProcessCustodyExecFile>();
        expect(await createWindowsMachineVitalsReader({ executablePath: null, execFile }).read({ sampledAt: 0, monotonicMs: 0, intervalMs: 60_000, overviewExtras: false })).toEqual({ state: 'unavailable', reason: 'helper_missing' });
        expect(execFile).not.toHaveBeenCalled();
    });
    it('reconciles cached composition with current used memory without waking extras tools', async () => {
        let calls = 0;
        const execFile = vi.fn<ProcessCustodyExecFile>().mockImplementation(async () => {
            const raw = JSON.parse(output(0));
            raw.sample.memory.availableBytes = calls++ === 0 ? 10_000 : 8_000;
            if (calls === 1) raw.sample.memory.composition = [{ kind: 'apps', bytes: 12_000 }, { kind: 'system', bytes: 4_000 }, { kind: 'cached_files', bytes: 6_000 }];
            return { stdout: JSON.stringify(raw), stderr: '' };
        });
        const reader = createWindowsMachineVitalsReader({ executablePath: '/helper', execFile });
        await reader.read({ sampledAt: 0, monotonicMs: 0, intervalMs: 2000, overviewExtras: true });
        const result = await reader.read({ sampledAt: 2000, monotonicMs: 2000, intervalMs: 2000, overviewExtras: true });
        expect(result).toMatchObject({ state: 'reporting', sample: { memory: { usedBytes: 24_000, composition: [{ kind: 'apps', bytes: 14_000 }, { kind: 'system', bytes: 4_000 }, { kind: 'cached_files', bytes: 6_000 }] } } });
        expect(execFile.mock.calls.filter(([command]) => command === '/helper').map(([, args]) => args)).toEqual([['vitals-sample', '--extras'], ['vitals-sample']]);
    });
});
