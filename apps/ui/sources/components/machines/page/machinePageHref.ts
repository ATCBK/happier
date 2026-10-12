import type { MachinesDoor } from './machinesDoor';
import type { MachinePageTabParams } from './machinePageTabQuery';
import type { MachineSubPageId } from './machineSubPages';
import { machinePageTabQuery } from './machinePageTabQuery';

export const MACHINES_COLLECTION_ROOT = '/settings/machines';
export const MACHINES_RAIL_ROOT = '/machines';

export function machinesIndexHref(door: MachinesDoor): string {
    return door === 'rail' ? MACHINES_RAIL_ROOT : MACHINES_COLLECTION_ROOT;
}

export type MachinePageTarget = Readonly<{ machineId: string; serverId?: string }>;

/** Where a machine resource alert opens, from a push or the Inbox: memory and CPU to Processes sorted by that column, disk to Storage. */
export function machineResourceAlertTab(kind: 'memory_pressure' | 'cpu_busy' | 'disk_nearly_full', volumeId?: string | null): MachinePageTabParams {
    if (kind === 'disk_nearly_full') return volumeId ? { id: 'storage', prepare: 'lowDisk', volumeId } : { id: 'storage' };
    return { id: 'processes', sort: kind === 'cpu_busy' ? 'cpu' : 'memory' };
}

/** One route owner for both Machines doors, their tabs and pushed sub-pages. */
export function machinePageHref(input: Readonly<{
    door: MachinesDoor;
    target: MachinePageTarget;
    tab?: MachinePageTabParams;
    page?: MachineSubPageId;
}>): string {
    const path = `${machinesIndexHref(input.door)}/${encodeURIComponent(input.target.machineId)}${input.page ? `/${input.page}` : ''}`;
    const query: string[] = [];
    const serverId = input.target.serverId?.trim();
    if (serverId) query.push(`serverId=${encodeURIComponent(serverId)}`);
    if (input.tab) {
        for (const [key, value] of Object.entries(machinePageTabQuery(input.tab))) query.push(`${key}=${encodeURIComponent(value)}`);
    }
    return query.length > 0 ? `${path}?${query.join('&')}` : path;
}
