import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

export const NVIDIA_VITALS_ARGS = ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'] as const;

export function parseNvidiaVitalsGpu(raw: string): NonNullable<MachineVitalsSampleV1['gpu']> {
    const gpu: NonNullable<MachineVitalsSampleV1['gpu']> = [];
    for (const line of raw.trim().split('\n')) {
        const [name, busy, used, total] = line.split(',').map((value) => value.trim());
        if (!name || busy === undefined) continue;
        const valid = (value: string | undefined) => value !== undefined && /^\d+(?:\.\d+)?$/u.test(value) && Number.isFinite(Number(value));
        gpu.push({ name, ...(valid(busy) && Number(busy) <= 100 ? { busyPct: Number(busy) } : {}), ...(valid(used) ? { memUsedBytes: Number(used) * 1024 * 1024 } : {}), ...(valid(total) ? { memTotalBytes: Number(total) * 1024 * 1024 } : {}) });
    }
    return gpu;
}
