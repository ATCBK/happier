import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { readLocalDaemonSharedState } from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { isDaemonOnActiveRelay } from '@/sync/domains/server/relayDrift/relayDriftModel';
import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import { getPluginExecutionOriginCandidateOrigin, type PluginExecutionOriginCandidateV1 } from './pluginExecutionOrigin';
import { readPluginMachineExecutionLastUsedTarget } from './selectionPreferences';
import { resolveFreshMachineAdministrationExecutionTarget } from './useTargetSelection';

/** Existing local/desktop facts only; election remains Administration-owned. */
export function readPluginExecutionOriginAutomaticHints(pluginId: string, candidates: readonly PluginExecutionOriginCandidateV1[],
    machineSnapshots?: readonly ServerMachineInventorySnapshotV1[]) {
    const scope = getActiveServerAccountScope();
    const profile = scope && getServerProfileById(scope.serverId);
    const local = readLocalDaemonSharedState<LocalDaemonStatusData>(getSystemTasksRunner()).status;
    const localMachineTarget = local?.machineId && profile?.serverIdentityId && local.daemonAccountId === scope?.accountId
        && isDaemonOnActiveRelay({ activeRelayUrl: profile.serverUrl, daemonRelayUrl: local.daemonServerUrl }) === true
        ? { serverIdentityId: profile.serverIdentityId, machineId: local.machineId } : null;
    const machineActivity = machineSnapshots ? machineSnapshots.flatMap(snapshot => snapshot.kind === 'resolved'
        ? snapshot.machines.map(machine => ({ serverIdentityId: snapshot.serverIdentityId, machineId: machine.id, activeAt: machine.activeAt })) : [])
        : candidates.flatMap(candidate => {
            const origin = getPluginExecutionOriginCandidateOrigin(candidate);
            const target = { serverIdentityId: origin.serverIdentityId, machineId: getPluginMachineExecutionOriginRef(origin).machineId };
            const fresh = resolveFreshMachineAdministrationExecutionTarget(target);
            return fresh ? [{ ...target, activeAt: fresh.machine.activeAt }] : [];
        });
    return { lastUsedTarget: readPluginMachineExecutionLastUsedTarget(scope, pluginId),
        localMachineTarget, machineActivity };
}
