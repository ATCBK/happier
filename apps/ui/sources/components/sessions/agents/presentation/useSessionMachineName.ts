import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { getStorage, useMachine, useServerScopedMachine } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { readSessionOwnerHostName } from '@/utils/sessions/sessionUtils';

/**
 * The name of the Machine a Session runs on ("MacBook Pro"), for copy that says where agents run and
 * what they wait for. While the Machine's record is not loaded it is the name the Session recorded
 * (the one its header and Work rows show); `null` only when neither is known, so copy falls back to a
 * sentence without a name rather than printing an id.
 */
export function useSessionMachineName(sessionId: string, serverId?: string | null): string | null {
    const target = useSessionReachableMachineTarget(sessionId, serverId);
    const machineId = target?.machineId ?? '';
    const scopedMachine = useServerScopedMachine(serverId, serverId ? machineId : '');
    const legacyMachine = useMachine(serverId ? '' : machineId);
    const machine = serverId ? scopedMachine : legacyMachine;
    const recordedName = getStorage()((state) => {
        const session = state.sessions[sessionId];
        return session ? readSessionOwnerHostName(session) : null;
    });
    if (!machine) return recordedName;
    const name = getMachineDisplayName(machine).trim();
    return name.length > 0 ? name : recordedName;
}
