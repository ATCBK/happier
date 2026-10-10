import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveExactServerScopedMachine } from './resolveServerScopedMachines';

type MachineDaemonCliVersionState = Readonly<{
    machines: Readonly<Record<string, Machine | undefined>>;
    machineListByServerId?: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>;

export function readMachineDaemonCliVersionForServerScope(params: Readonly<{
    state: MachineDaemonCliVersionState;
    machineId: string;
    serverId?: string | null;
    activeServerId?: string | null;
}>): string | null {
    const machineId = typeof params.machineId === 'string' ? params.machineId.trim() : '';
    if (!machineId) return null;

    const serverId = typeof params.serverId === 'string' ? params.serverId.trim() : '';
    const activeServerId = typeof params.activeServerId === 'string' ? params.activeServerId.trim() : '';
    const scopedServerId = serverId || activeServerId;
    const machine = scopedServerId ? resolveExactServerScopedMachine({
        machineId, serverId: scopedServerId, activeServerId,
        activeMachines: Object.values(params.state.machines).filter((machine): machine is Machine => Boolean(machine)),
        machineListByServerId: params.state.machineListByServerId ?? {},
        machineListStatusByServerId: params.state.machineListStatusByServerId,
    }) : params.state.machines[machineId];
    const version = machine?.daemonState?.cliVersion;
    return typeof version === 'string' && version.trim().length > 0 ? version.trim() : null;
}
