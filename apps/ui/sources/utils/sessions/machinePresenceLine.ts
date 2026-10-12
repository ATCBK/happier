import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';

export type MachinePresenceLine = Readonly<{
    online: boolean;
    /** Native retained power when known, otherwise ordinary connectivity/last-seen. */
    label: string;
}>;

/**
 * The presence half of a machine's status line, shared by every surface that lists machines with a
 * status line (the home hub's Machines section, the machine picker rows), so a machine reads the
 * same wherever it appears. Callers append their own facts after it ("· Update available").
 */
export function describeMachinePresenceLine(
    machine: Readonly<{ id?: string; active: boolean; activeAt?: number | null; revokedAt?: number | null }>,
    nowMs?: number,
    managedMachine?: ManagedMachineV1 | null,
    serverId?: string | null,
): MachinePresenceLine {
    const presenceOnline = isMachineOnline(machine, nowMs);
    const online = machine.id && serverId
        ? isMachineReachable(serverId, { ...machine, id: machine.id }, nowMs)
        : presenceOnline;
    const lastSeen = formatLastSeen(machine.activeAt ?? 0);
    // A fresh heartbeat with a failed request from this Home is a live machine this Home cannot
    // reach, not an offline one ("Offline · last seen just now" contradicts itself). "Offline"
    // stays for a stale heartbeat.
    const word = online ? t('settingsOverview.machineOnline')
        : presenceOnline
            ? t('settingsOverview.machineUnreachableFromHome', { lastSeen })
            : t('settingsOverview.machineOffline', { lastSeen });
    return {
        online,
        label: resolveWorkStatusTone({ kind: 'machine', facts: {
            online, word, machineId: machine.id, revokedAt: machine.revokedAt, managedMachine, needsYouCount: 0, runningSessionCount: 0,
        } }).word,
    };
}
