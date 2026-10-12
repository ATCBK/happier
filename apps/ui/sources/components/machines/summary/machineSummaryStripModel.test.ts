import { describe, expect, it } from 'vitest';
import type { MachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import {
    buildMachineSummaryInstruments,
    fitMachineSummaryMetrics,
    normalizeMachineSummaryMetrics,
} from './machineSummaryStripModel';
import { t } from '@/text';

const GB = 1024 ** 3;
const line = (values: readonly (number | null)[]) => values.map((y, index) => ({ t: index * 15_000, y }));

function summary(overrides: Partial<MachineResourceSummaryV1> = {}): MachineResourceSummaryV1 {
    return {
        sampledAt: 1, stepMs: 15_000, seriesFrom: 0,
        cpu: { busyPct: 12.4, tone: 'calm', series: line([2, 3, 2, 3]) },
        memory: { availableBytes: 71 * GB, totalBytes: 128 * GB, pressure: 'calm', tone: 'calm', series: line([44, 45]) },
        disk: { volumeId: 'v', volumeLabel: 'Macintosh HD', availableBytes: 412 * GB, totalBytes: 994 * GB, tone: 'calm', series: [] },
        network: { rxBps: 2_000_000, txBps: 340_000, tone: 'calm', rxSeries: line([1, 2]), txSeries: line([1, 1]) },
        ...overrides,
    };
}

describe('the Machine summary value convention', () => {
    it('keeps an empty Show (names only), drops unknown ids and orders the rest canonically', () => {
        expect(normalizeMachineSummaryMetrics([])).toEqual([]);
        expect(normalizeMachineSummaryMetrics(['network', 'cpu', 'cpu', 'gpu'])).toEqual(['cpu', 'network']);
        expect(normalizeMachineSummaryMetrics('cpu')).toEqual(['cpu', 'memory', 'disk']);
    });

    it('says CPU in use and memory and disk free, while meters fill by what is used', () => {
        const instruments = buildMachineSummaryInstruments(summary());
        expect(instruments.cpu.figure).toBe('12%');
        expect(instruments.memory.figure).toBe('71 GB');
        expect(instruments.memory.used).toBeCloseTo(57 / 128);
        expect(instruments.disk.figure).toBe('442 GB');
        expect(instruments.disk.used).toBeCloseTo(582 / 994);
        expect(instruments.memory.exact).toContain('71 GB');
    });

    it('shows nothing for a metric the machine did not measure, never zero', () => {
        const instruments = buildMachineSummaryInstruments(summary({ cpu: { busyPct: null, tone: 'calm', series: [] } }));
        expect(instruments.cpu.figure).toBeNull();
        expect(instruments.cpu.used).toBeNull();
        expect(instruments.cpu.exact).toBeNull();
    });

    it('says the pressure word in tone when memory is not calm', () => {
        const instruments = buildMachineSummaryInstruments(summary({
            memory: { availableBytes: 0.2 * GB, totalBytes: 4 * GB, pressure: 'critical', tone: 'crit', series: line([95, 99]) },
        }));
        expect(instruments.memory.tone).toBe('crit');
        expect(instruments.memory.figure).toBe(t('machineSummary.pressure.critical'));
    });

    it('keeps a 2 → 3 % CPU wiggle flat: the line scales to its peak, never below 40 %', () => {
        const flat = buildMachineSummaryInstruments(summary()).cpu.line;
        expect(Math.max(...flat.map(value => value ?? 0))).toBeLessThanOrEqual(3 / 40 + 1e-9);
        const busy = buildMachineSummaryInstruments(summary({ cpu: { busyPct: 80, tone: 'calm', series: line([20, 80]) } })).cpu.line;
        expect(busy).toEqual([0.25, 1]);
    });

    it('lets calm metrics yield first when there is no room, and never drops a toned one', () => {
        const instruments = buildMachineSummaryInstruments(summary({
            disk: { volumeId: 'v', volumeLabel: '/data', availableBytes: 10 * GB, totalBytes: 1800 * GB, tone: 'warn', series: [] },
        }));
        expect(fitMachineSummaryMetrics(['cpu', 'memory', 'disk', 'network'], instruments, 2)).toEqual(['cpu', 'disk']);
        expect(fitMachineSummaryMetrics(['cpu', 'disk'], instruments, 1)).toEqual(['disk']);
    });
});
