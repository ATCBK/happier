import type { MachinePageTabParams } from './machinePageTabQuery';

/**
 * The tab last open on each machine during this app session (MPG-7), shared by both doors: opening
 * the machine again, from either door, returns to it unless the link names a tab. Same lifetime as
 * the collection's visit memory; nothing is persisted.
 */
const lastTabByMachine = new Map<string, MachinePageTabParams>();

function machineKey(target: Readonly<{ serverId: string; machineId: string }>): string {
    return `${target.serverId}\u0000${target.machineId}`;
}

export function readRememberedMachinePageTab(target: Readonly<{ serverId: string; machineId: string }>): MachinePageTabParams | null {
    return lastTabByMachine.get(machineKey(target)) ?? null;
}

export function rememberMachinePageTab(target: Readonly<{ serverId: string; machineId: string }>, params: MachinePageTabParams): void {
    lastTabByMachine.set(machineKey(target), params);
}
