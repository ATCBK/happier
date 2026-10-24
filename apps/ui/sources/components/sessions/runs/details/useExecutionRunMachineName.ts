import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';

/**
 * The machine a Run lives on, in the person's words: its display name, else the host the Session
 * recorded, else "this machine". The Run page says where it reads from and what a stop affects, so
 * it names the machine rather than a raw id.
 */
export function useExecutionRunMachineName(
    session: Parameters<typeof readSessionOwnerMetadataView>[0] | null | undefined,
    serverId?: string | null,
    workspaceMachineId?: string | null,
): Readonly<{ machineId: string | null; name: string }> {
    const sessionMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const machineId = resolveSessionMachineId(sessionMetadata) ?? (workspaceMachineId?.trim() || null);
    const machineName = useServerScopedMachine(serverId, machineId, readMachineName);
    const host = sessionMetadata?.host?.trim() ?? '';
    const name = machineName || host || t('runPage.thisMachine');
    return { machineId, name };
}
