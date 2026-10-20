import * as React from 'react';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useMachineListStatusByServerId, useMachineRecordListsByServerId, useMachineRecordValues } from '@/sync/store/hooks';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { buildMachineAdministrationCandidatesFromSnapshots } from '@/sync/domains/machines/administration/targetState';
import { machineAdministrationTargetsEqual, resolveMachineAdministrationTargetState } from '@/sync/domains/machines/administration/targetSelection';
import { areServerAccountScopesEqual, createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * Machines the legacy Profile migration may target on the active server. This
 * flow keeps only an ephemeral preference; scoped inventory and fleet admission
 * own which machines may execute it.
 */
export function useLegacyProfileMigrationTarget() {
    const snapshots = useAllProfileMachineInventorySnapshots();
    const activeMachines = useMachineRecordValues();
    const machineListByServerId = useMachineRecordListsByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const activeServer = useActiveServerSnapshot();
    const serverId = typeof activeServer.serverId === 'string' ? activeServer.serverId : null;
    const [preferredTarget, setPreferredTarget] = React.useState<Readonly<{
        scope: ServerAccountScope;
        target: MachineAdministrationTargetV1;
    }> | null>(null);
    const snapshot = React.useMemo(() => snapshots.find(row => row.kind === 'resolved'
        && (row.serverIdentityId === serverId || row.profileId === serverId)), [serverId, snapshots]);
    const scope = React.useMemo(() => snapshot?.kind === 'resolved'
        ? createServerAccountScope(snapshot.serverIdentityId, snapshot.accountId) : null, [snapshot]);
    const targetMachines = React.useMemo(() => {
        if (!snapshot || snapshot.kind !== 'resolved') return [];
        const eligibleIds = new Set(snapshot.executionEligibleMachineIds);
        const machines = resolveServerScopedMachines({
            serverId: snapshot.serverIdentityId,
            serverIdAliases: [snapshot.profileId],
            activeServerId: serverId ?? '',
            activeMachines,
            machineListByServerId,
            machineListStatusByServerId,
        }) ?? [];
        const machinesById = new Map(machines.map(machine => [machine.id, machine]));
        // Preserve the inventory owner's order and visible persistent identities;
        // raw records only adapt its admitted rows to the existing selector.
        return snapshot.machines.flatMap(machine => {
            const target = machinesById.get(machine.id);
            return target && eligibleIds.has(machine.id) ? [target] : [];
        });
    }, [activeMachines, machineListByServerId, machineListStatusByServerId, serverId, snapshot]);
    const candidates = React.useMemo(() => {
        const eligibleIds = new Set(targetMachines.map(machine => machine.id));
        return buildMachineAdministrationCandidatesFromSnapshots({ snapshots: snapshot ? [snapshot] : [] })
            .filter(candidate => eligibleIds.has(candidate.target.machineId));
    }, [snapshot, targetMachines]);
    const setPreferredMachineId = React.useCallback((selectedMachineId: string) => {
        const candidate = candidates.find(row => row.target.machineId === selectedMachineId);
        setPreferredTarget(scope && candidate ? { scope, target: candidate.target } : null);
    }, [candidates, scope]);
    const machineId = React.useMemo(() => {
        const storedTarget = preferredTarget && areServerAccountScopesEqual(preferredTarget.scope, scope)
            && candidates.some(candidate => machineAdministrationTargetsEqual(candidate.target, preferredTarget.target))
            ? preferredTarget.target : null;
        const selection = resolveMachineAdministrationTargetState({ storedTarget, candidates });
        return selection.kind === 'online' ? selection.target.machineId : null;
    }, [candidates, preferredTarget, scope]);

    return { machineId, serverId, targetMachines, setPreferredMachineId } as const;
}
