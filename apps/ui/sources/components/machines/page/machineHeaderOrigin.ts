import type { WindowFlightRect } from '@/components/ui/motion/rectFlight';

/**
 * The one-shot hand-off of a popover row's rectangle to the machine page it opens (MPG-32, §4.12): set by
 * the row press (window coordinates), taken once by the first header of that machine to mount. A later
 * or different mount finds nothing and simply does not travel; there is no timer.
 */
let pending: Readonly<{ machineKey: string; rect: WindowFlightRect }> | null = null;

export function machineHeaderOriginKey(target: Readonly<{ serverId?: string | null; machineId: string }>): string {
    return `${target.serverId ?? ''}\u0000${target.machineId}`;
}

export function setMachineHeaderOrigin(machineKey: string, rect: WindowFlightRect | null): void {
    pending = rect ? { machineKey, rect } : null;
}

/** The pending origin for this machine, cleared as it is read; `null` for any other machine. */
export function takeMachineHeaderOrigin(machineKey: string): WindowFlightRect | null {
    if (!pending) return null;
    const { machineKey: key, rect } = pending;
    pending = null;
    return key === machineKey ? rect : null;
}

export function clearMachineHeaderOrigin(): void {
    pending = null;
}
