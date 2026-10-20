import type { MachineVitalsHostFactsV1, MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

export interface MachineVitalsReaderInput {
    sampledAt: number;
    monotonicMs: number;
    intervalMs: number;
    /** Parked Overview demand: memory detail is read with each observation, not cached extras. */
    overview?: boolean;
    /** AC facts needed by Overview or an enabled power-dependent policy; never changes cadence. */
    power?: boolean;
    overviewExtras: boolean;
}

/** Native cumulative counters; the sampler owns exact wall-minute aggregation. */
export interface MachineVitalsMinuteCountersV1 {
    monotonicMs: number;
    cpu: { busy: number; total: number } | null;
    containerCpu?: { usageUsec: number; quotaCores: number };
    network: { interfaceIds: string[]; rxBytes: number; txBytes: number } | null;
    swap?: { in: number; out: number };
}

export type MachineVitalsReaderResult =
    | { state: 'reporting'; sample: MachineVitalsSampleV1; host: MachineVitalsHostFactsV1; minuteCounters: MachineVitalsMinuteCountersV1 }
    | { state: 'unavailable'; reason: 'helper_missing' | 'reader_failed' | 'helper_failing' };

export interface MachineVitalsReader {
    read(input: MachineVitalsReaderInput): Promise<MachineVitalsReaderResult>;
}
