import type { MachineResourcesPolicyGetResultV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readSyncedMachineResourcesPolicy } from '@/sync/domains/machines/resources/machineResourcesPolicy';

export function machineResourcesPolicyGet(machineId: string, options?: Readonly<{ serverId?: string | null }>): MachineResourcesPolicyGetResultV1 {
    return readSyncedMachineResourcesPolicy(resolveServerScopedMachine(storage.getState(), options?.serverId, machineId));
}
