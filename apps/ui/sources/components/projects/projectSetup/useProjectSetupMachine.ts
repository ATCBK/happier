import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

/** The Machine a setup review runs on, as the review names it; a teammate's shared Machine also names its OS user. */
export function useProjectSetupMachine(serverId: string | null, machineId: string | null) {
  const machine = useServerScopedMachine(serverId, machineId ?? '');
  return {
    machineName: getMachineDisplayName(machine) ?? machineId ?? '',
    sharedRunAs: machine?.isShared ? (machine.metadata?.username ?? null) : null,
  };
}
