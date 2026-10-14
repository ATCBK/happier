import { readHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { machineResourceStore } from './machineResourceStore';
import { resolveMachineResourceKey, type MachineResourceKey } from './machineRpc';

export async function retryMachineResourceSummaries(machineKeys: readonly MachineResourceKey[]): Promise<void> {
    if (!readHostActivelyViewed()) return;
    await Promise.all(machineKeys.map(async input => {
        const key = await resolveMachineResourceKey(input);
        if (key && readHostActivelyViewed()) await machineResourceStore.retry({ ...key, view: 'summary' });
    }));
}
