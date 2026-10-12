import { readHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { machineResourceStore } from './machineResourceStore';
import type { MachineResourceKey } from './machineRpc';

/** Pointer-enter/focus warms the first frame once; only opening a surface creates demand. */
export async function warmMachineResourceSummaries(machineKeys: readonly MachineResourceKey[]): Promise<void> {
    if (!readHostActivelyViewed()) return;
    await Promise.all(machineKeys.map(input => {
        machineResourceStore.daemonStateChanged(input, input.daemonStateVersion);
        return machineResourceStore.warm(input);
    }));
}
