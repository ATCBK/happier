import type { MachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';

import type { MachineResourceAvailability } from '@/sync/domains/machines/resources/useMachineResourceSummary';

/** Memory reads in the binary base and disks in the decimal one, as the byte formatter shows them. */
const GB = 1024 ** 3;
const DISK_GB = 1e9;

function series(values: readonly number[]): MachineResourceSummaryV1['cpu']['series'] {
    return values.map((y, index) => ({ t: index * 15_000, y }));
}

function summary(input: Readonly<{
    cpu: number; cpuLine: readonly number[]; memoryFreeGb: number; memoryTotalGb: number; memoryLine: readonly number[];
    diskFreeGb: number; diskTotalGb: number; diskTone: MachineResourceSummaryV1['disk']['tone']; rxBps: number;
}>): MachineResourceAvailability {
    const value: MachineResourceSummaryV1 = {
        sampledAt: 0, stepMs: 15_000, seriesFrom: 0,
        cpu: { busyPct: input.cpu, tone: 'calm', series: series(input.cpuLine) },
        memory: { availableBytes: input.memoryFreeGb * GB, totalBytes: input.memoryTotalGb * GB, pressure: 'calm', tone: 'calm', series: series(input.memoryLine) },
        disk: { volumeId: null, volumeLabel: null, availableBytes: input.diskFreeGb * DISK_GB, totalBytes: input.diskTotalGb * DISK_GB, tone: input.diskTone, series: [] },
        network: { rxBps: input.rxBps, txBps: input.rxBps / 4, tone: 'calm', rxSeries: series([3, 4, 2, 6, 5, 7, 4]), txSeries: series([1, 1, 2, 1, 2, 1, 1]) },
    };
    return { kind: 'reporting', summary: value, freshness: 'live' };
}

/**
 * The style tiles' two static machines (lab `CS`): one calm, one that needs a look. Pure data at static
 * props: the tiles render the real strip, never a drawing of it, and never subscribe or ask a machine.
 */
export const MACHINE_SUMMARY_PREVIEW = Object.freeze({
    calm: summary({ cpu: 4, cpuLine: [3, 4, 3, 5, 4, 4, 3, 4], memoryFreeGb: 19, memoryTotalGb: 32, memoryLine: [40, 41, 41, 40, 41, 42, 41, 41],
        diskFreeGb: 310, diskTotalGb: 512, diskTone: 'calm', rxBps: 120_000 }),
    look: summary({ cpu: 61, cpuLine: [55, 58, 62, 60, 64, 59, 61, 61], memoryFreeGb: 148, memoryTotalGb: 256, memoryLine: [42, 43, 42, 43, 42, 43, 42, 42],
        diskFreeGb: 164, diskTotalGb: 1800, diskTone: 'warn', rxBps: 2_100_000 }),
});
