import * as React from 'react';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { useMachineProcesses } from '../processes/useMachineProcesses';
import { useMachineStorageSummary } from '../storage/useMachineStorageSummary';
import type { MachineStorageHookInput } from '../storage/useMachineStorage';
import { attributeMachineUsage, type MachineAttributedUsage } from '@happier-dev/protocol/machines/resources/machineUsageAttribution';

export type MachineVitalsAttributionState = Readonly<{
    processes: ReturnType<typeof useMachineProcesses>;
    storage: ReturnType<typeof useMachineStorageSummary>;
    happier: MachineAttributedUsage | null;
    everythingElse: MachineAttributedUsage | null;
}>;

/** Overview supplies its existing sample; the process and storage owners supply attribution. */
export function useMachineVitalsAttribution(input: MachineStorageHookInput & Readonly<{ sample: MachineVitalsSampleV1 | null }>): MachineVitalsAttributionState {
    const processes = useMachineProcesses({ machineId: input.machineId, serverId: input.serverId, scope: 'happier', view: 'tree', enabled: input.enabled, online: input.online });
    const storage = useMachineStorageSummary(input);
    return React.useMemo(() => {
        const totals = processes.answer?.totals;
        if (!totals) return { processes, storage, happier: null, everythingElse: null };
        const sample = input.sample;
        return { processes, storage, ...attributeMachineUsage(totals, {
            usedMemoryBytes: sample?.memory.reported ? sample.memory.usedBytes : null,
            cpuBusyPercent: sample?.cpu.reported ? sample.cpu.busyPct : null,
        }) };
    }, [processes, storage, input.sample]);
}
