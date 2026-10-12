import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDarwinBatteryFacts } from '@happier-dev/cli-common/process';
import { parseDarwinGpu, parseDarwinHardwarePorts, parseDarwinThermal, parseDarwinVmStat } from './darwinParsers';

// Captured on mac-host, 2026-10-10; GPU fixture retains only observed fields used here.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');

describe('Darwin captured tool outputs', () => {
    it('uses resident compressor pages and makes composition add up to memory in use', () => {
        const used = 87_960_930_223;
        const composition = parseDarwinVmStat(fixture('darwin-vm-stat'), used);
        expect(composition?.find((item) => item.kind === 'compressed')?.bytes).toBe(4_586_235 * 16_384);
        expect(composition?.reduce((sum, item) => sum + item.bytes, 0)).toBe(used);
    });
    it('keeps an attached battery on AC and does not report charging from the negated phrase', () => {
        expect(parseDarwinBatteryFacts(fixture('darwin-pmset')).battery).toMatchObject({ pct: 80, onAC: true });
        expect(parseDarwinBatteryFacts(fixture('darwin-pmset')).battery?.state).not.toBe('charging');
    });
    it('accepts no recorded warnings as nominal and keeps absent telemetry absent', () => {
        expect(parseDarwinThermal(fixture('darwin-thermal'))).toEqual({ state: 'nominal', throttled: false });
        expect(parseDarwinThermal('unrecognised output')).toBeUndefined();
    });
    it('keeps GPU zero utilisation real but never interprets driver allocations as GPU memory', () => {
        expect(parseDarwinGpu(fixture('darwin-gpu'))).toEqual([{ name: 'Apple M5 Max', busyPct: 0, cores: 40 }]);
        expect(parseDarwinGpu('no accelerators')).toBeUndefined();
    });
    it('keeps a positively powered-off accelerator without stale utilisation or memory', () => {
        const raw = '+-o DiscreteGPU\n { "model" = "Discrete GPU"\n "AGCInfo" = {"poweredOffByAGC"=1}\n "PerformanceStatistics" = {"Device Utilization %"=72} }';
        expect(parseDarwinGpu(raw)).toEqual([{ name: 'Discrete GPU', powerState: 'off' }]);
        expect(parseDarwinGpu(raw.replace('=1}', '=0}'))).toEqual([{ name: 'Discrete GPU', busyPct: 72 }]);
        expect(parseDarwinGpu(raw.replace('"poweredOffByAGC"=1', '"fBusyCount"=0'))).toEqual([{ name: 'Discrete GPU', busyPct: 72 }]);
    });
    it('maps a hardware port to its device without per-tick lookups', () => {
        expect(parseDarwinHardwarePorts('Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: fc:b2:14:a5:db:6d\n').get('en0')).toBe('Wi-Fi');
    });
});
