import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { loadMachineDisplayWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import {
    useMachineListStatusByServerId,
    useMachineRecordListsByServerId,
    useMachineRecordValues,
} from '@/sync/store/hooks';

import {
    resolveAllProfileMachineInventorySnapshots,
    type ServerMachineInventorySnapshotV1,
} from './machineInventorySnapshots';
import { useMachineReachabilityRevision } from './reachability/useMachineReachabilityRevision';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';

const EMPTY_MACHINE_INVENTORY_SNAPSHOTS: readonly ServerMachineInventorySnapshotV1[] = Object.freeze([]);

/**
 * The one React projection over the all-profile raw inventory and its
 * presentation-only warm fallback. Administration consumers share this hook
 * instead of independently interpreting active/concurrent machine stores.
 */
export function useAllProfileMachineInventorySnapshots(enabled = true): readonly ServerMachineInventorySnapshotV1[] {
    const activeServer = useActiveServerSnapshot();
    const serverProfilesGeneration = useServerProfilesGeneration();
    const profiles = React.useMemo(() => listServerProfiles(), [serverProfilesGeneration]);
    const activeMachines = useMachineRecordValues(enabled);
    const machineListByServerId = useMachineRecordListsByServerId(enabled);
    const machineListStatusByServerId = useMachineListStatusByServerId(enabled);
    const bindings = useServerCredentialAccountScopeBindings(enabled ? profiles.map(profile => profile.serverIdentityId) : []);
    const accountScopesByServerId = React.useMemo(() => new Map([...bindings].flatMap(([serverId, binding]) =>
        binding.isCurrent() ? [[serverId, binding.scope] as const] : [])), [bindings]);
    const reachabilityRevision = useMachineReachabilityRevision(enabled);
    const presenceMachines = React.useMemo(() => enabled
        ? [...activeMachines, ...Object.values(machineListByServerId).flatMap(machines => machines ?? [])] : [],
    [enabled, activeMachines, machineListByServerId]);
    const nowMs = useMachinePresenceNowMs(presenceMachines);

    return React.useMemo(() => enabled ? resolveAllProfileMachineInventorySnapshots({
        profiles,
        activeServerId: activeServer.serverId,
        activeMachines,
        machineListByServerId,
        machineListStatusByServerId,
        accountScopesByServerId,
        nowMs,
        loadWarmEntries: loadMachineDisplayWarmCacheEntries,
    }) : EMPTY_MACHINE_INVENTORY_SNAPSHOTS, [
        enabled,
        activeMachines,
        activeServer.serverId,
        machineListByServerId,
        machineListStatusByServerId,
        accountScopesByServerId,
        profiles,
        reachabilityRevision,
        nowMs,
    ]);
}
