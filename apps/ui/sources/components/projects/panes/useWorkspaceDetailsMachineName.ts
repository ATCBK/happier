import { useMachineDisplayById } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

/** Details chrome needs the selected Machine's name, not its runtime inventory. */
export function useWorkspaceDetailsMachineName(machineId: string): string {
    return useMachineDisplayById(machines => getMachineDisplayName(machines[machineId] ?? null) ?? machineId);
}
