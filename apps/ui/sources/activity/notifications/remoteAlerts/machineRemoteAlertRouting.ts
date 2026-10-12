import { MachineRemoteAlertV1Schema, type MachineRemoteAlertV1 } from '@happier-dev/protocol/push/machineRemoteAlert';
import { resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';

export type IncomingMachineRemoteAlert =
    | Readonly<{ kind: 'not_machine_alert' }>
    | Readonly<{ kind: 'unroutable' }>
    | Readonly<{ kind: 'routable'; alert: MachineRemoteAlertV1; serverId: string; serverUrl: string }>;

/** A Machine alert cannot borrow the active Home or fall through to a Session payload. */
export function resolveIncomingMachineRemoteAlert(data: unknown): IncomingMachineRemoteAlert {
    if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'machine_alert') return { kind: 'not_machine_alert' };
    const parsed = MachineRemoteAlertV1Schema.safeParse(data);
    if (!parsed.success) return { kind: 'unroutable' };
    const home = resolveServerProfileForPortableIdentity(parsed.data.serverId);
    return home.kind === 'resolved'
        ? { kind: 'routable', alert: parsed.data, serverId: home.profile.id, serverUrl: home.profile.serverUrl }
        : { kind: 'unroutable' };
}
