import { readHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { machineResourceStore } from './machineResourceStore';
import type { MachineResourceKey } from './machineRpc';

export function retryMachineResourceSummaries(machineKeys: readonly MachineResourceKey[]): void {
    if (!readHostActivelyViewed()) return;
    for (const input of machineKeys) machineResourceStore.retry({ ...input, view: 'summary' });
}
