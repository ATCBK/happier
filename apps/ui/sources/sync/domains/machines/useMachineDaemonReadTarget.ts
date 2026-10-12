import * as React from 'react';

import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { storage } from '@/sync/domains/state/storageStore';
import { useMachinePresenceSummary, useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

export type MachineDaemonReadKey = Readonly<{ machineId: string; serverId: string | null; expectedAccountId: string | null }>;
export type MachineDaemonReadTargetInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    expectedAccountId?: string | null;
    daemonStateVersion?: number | null;
    enabled?: boolean;
    online?: boolean;
}>;

/**
 * Who a daemon read for one machine is made as, and whether it may run now: the exact Home/Account
 * identity from the existing credential owner (including other Homes), the machine's presence, and
 * whether the app is being looked at. One target for every daemon-backed machine read (storage,
 * guard, processes), so they never disagree about which Account is asking.
 */
export function useMachineDaemonReadTarget(input: MachineDaemonReadTargetInput): Readonly<{
    key: MachineDaemonReadKey;
    enabled: boolean;
    offline: boolean;
    accountBinding: ServerCredentialAccountScopeBinding | null;
    daemonStateVersion: number | null | undefined;
}> {
    const { binding, serverId, expectedAccountId, viewed } = useMachineDaemonReadIdentity(input);
    const key = React.useMemo(() => ({ machineId: input.machineId, serverId, expectedAccountId }), [input.machineId, serverId, expectedAccountId]);
    const presence = useMachinePresenceSummary(serverId, input.machineId);
    const selectVersion = React.useCallback((state: Parameters<typeof resolveServerScopedMachine>[0]) => resolveServerScopedMachine(state, serverId, input.machineId)?.daemonStateVersion, [input.machineId, serverId]);
    const reportedVersion = storage(selectVersion);
    const online = input.online ?? (presence.reachability !== 'unreachable');
    const enabled = viewed && input.enabled !== false && online && !!binding
        && binding.accountId === expectedAccountId && binding.isCurrent();
    return { key, enabled, offline: !online, accountBinding: binding, daemonStateVersion: input.daemonStateVersion ?? reportedVersion };
}

/** Who asks, once for a Home: the credential owner's identity and whether the app is being looked at. */
function useMachineDaemonReadIdentity(input: Readonly<{ serverId?: string | null; expectedAccountId?: string | null }>) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(input.serverId);
    const viewed = useHostActivelyViewed();
    // The credential owner retains a settled identity during metadata rechecks, but
    // withdraws it on credential mutation. Keep projection continuity, not stale authority.
    const scope = resolution.kind === 'bound' ? resolution.scope : null;
    const serverId = binding?.serverId ?? scope?.serverId ?? input.serverId ?? null;
    const expectedAccountId = input.expectedAccountId ?? binding?.accountId ?? scope?.accountId ?? null;
    return { binding, serverId, expectedAccountId, viewed };
}

export type MachineDaemonReadTargetEntry = Readonly<{ key: MachineDaemonReadKey; enabled: boolean; offline: boolean }>;

/**
 * The same read target for several machines of one Home (an all-machines widget): one credential identity,
 * each machine's own presence. A daemon read stays per machine; this only names the targets together.
 */
export function useMachineDaemonReadTargets(input: Readonly<{ serverId?: string | null; machineIds: readonly string[]; enabled?: boolean }>): readonly MachineDaemonReadTargetEntry[] {
    const { binding, serverId, expectedAccountId, viewed } = useMachineDaemonReadIdentity(input);
    const idsKey = JSON.stringify(input.machineIds);
    const presence = useMachinePresenceSummaries(serverId, input.machineIds);
    const onlineKey = JSON.stringify(presence.map(machine => machine.reachability !== 'unreachable'));
    const current = viewed && input.enabled !== false && !!binding && binding.accountId === expectedAccountId && binding.isCurrent();
    return React.useMemo(() => {
        const online = JSON.parse(onlineKey) as boolean[];
        return (JSON.parse(idsKey) as string[]).map((machineId, index) => ({
            key: { machineId, serverId, expectedAccountId },
            enabled: current && online[index] === true,
            offline: online[index] !== true,
        }));
    }, [current, expectedAccountId, idsKey, onlineKey, serverId]);
}
