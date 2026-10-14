import { readHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { machineResourceStore } from './machineResourceStore';
import { resolveMachineResourceKey, type MachineResourceKey } from './machineRpc';

/** Pointer-enter/focus warms the first frame once; only opening a surface creates demand. */
export async function warmMachineResourceSummaries(machineKeys: readonly MachineResourceKey[]): Promise<void> {
    if (!readHostActivelyViewed()) return;
    await Promise.all(machineKeys.map(async input => {
        const key = await resolveMachineResourceKey(input);
        if (!key || !readHostActivelyViewed()) return;
        machineResourceStore.daemonStateChanged(key, input.daemonStateVersion);
        return machineResourceStore.warm(key);
    }));
}
