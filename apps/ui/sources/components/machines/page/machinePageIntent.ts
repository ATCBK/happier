import { machineStorageStore } from '@/sync/domains/machines/storage/machineStorageStore';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { MachinePageTabParams } from './machinePageTabQuery';

/**
 * What opening a machine page tab from an attention entry does before it navigates. The person's tap
 * on "Free up space" (the popover row, a needs-you list, the page header, Home, a push or an Inbox
 * notice) is the intent to prepare the low-disk pile (plan 40 STO-23), so that tap — never the
 * Storage tab's mount — puts the quickest verified Safe items in the pile through the ordinary collect
 * Action. Every other tab opens as it is.
 */
export function beginMachinePageTabIntent(target: Readonly<{ serverId?: string | null; machineId: string }>, tab: MachinePageTabParams | null | undefined): void {
    if (tab?.id !== 'storage' || tab.prepare !== 'lowDisk' || !tab.volumeId) return;
    fireAndForget(machineStorageStore.prepareLowDisk({ machineId: target.machineId, serverId: target.serverId ?? null, volumeId: tab.volumeId }),
        { tag: 'machinePageIntent.lowDisk' });
}
