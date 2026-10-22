import * as React from 'react';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useSetting } from '@/sync/domains/state/storage';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    isMachineAdministrationCandidateExplicitlySelectable,
    machineAdministrationTargetsEqual,
    resolveMachineAdministrationTargetState,
    readMachineAdministrationTargetRouteParams,
    type MachineAdministrationTargetRouteParamsV1,
    type MachineAdministrationCandidateV1,
} from '@/sync/domains/machines/administration/targetSelection';
import {
    useMachineAdministrationTargetSelection,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { describeMachineLockedReason, getMachineSentenceName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { presentMachineAdministrationTargetState } from '@/components/settings/machines/MachineAdministrationTargetSelector';

/**
 * The machine the Agents pages manage. Agents show a machine's last known state while it is away,
 * so an offline machine stays choosable; automatic selection still takes only a sole live one.
 */
export function useAgentsAdministrationTargetSelection(route?: MachineAdministrationTargetRouteParamsV1): MachineAdministrationTargetSelectionV1 {
    const initialTarget = React.useMemo(() => route ? readMachineAdministrationTargetRouteParams(route) : null,
        [route?.machineId, route?.serverIdentityId]);
    return useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents, {
        explicitSelection: 'lastKnown',
        ...(route ? { initialTarget } : {}),
    });
}

/** How the Agents machine picker presents a candidate: offline machines stay choosable. */
export function resolveAgentsMachineCandidateAvailability(candidate: MachineAdministrationCandidateV1): Readonly<{
    detail: string;
    selectable: boolean;
}> {
    const selectable = isMachineAdministrationCandidateExplicitlySelectable(candidate, 'lastKnown');
    if (candidate.availability === 'online' && candidate.observation === 'live') {
        return { detail: t('settingsProviders.detail.machineOnline'), selectable };
    }
    if (candidate.availability === 'online' || candidate.availability === 'offline') {
        return { detail: t('settingsAgents.offline.pickerDetail'), selectable };
    }
    const presentation = presentMachineAdministrationTargetState(resolveMachineAdministrationTargetState({
        storedTarget: candidate.target, candidates: [candidate],
    }));
    return { detail: presentation.detail ?? presentation.title, selectable };
}

/**
 * The selected machine as the Agents pages address it: live when it can run operations, otherwise
 * the last known scope whose cached projection is still worth showing.
 */
export function useAgentsMachineScope(targetSelection: MachineAdministrationTargetSelectionV1) {
    const executionTarget = React.useMemo(() => {
        const selectedTarget = targetSelection.selectedTarget;
        const resolvedTarget = targetSelection.resolveExecutionTarget();
        return selectedTarget !== null
            && resolvedTarget !== null
            && machineAdministrationTargetsEqual(selectedTarget, resolvedTarget.target)
            ? resolvedTarget
            : null;
    }, [targetSelection]);
    const selectedRow = React.useMemo(() => {
        const selectedTarget = targetSelection.selectedTarget;
        return selectedTarget
            ? targetSelection.pickerRows.find((row) => machineAdministrationTargetsEqual(row.candidate.target, selectedTarget)) ?? null
            : null;
    }, [targetSelection.pickerRows, targetSelection.selectedTarget]);
    const machineId = executionTarget?.machine.id ?? selectedRow?.machine.id ?? null;
    const serverId = executionTarget?.serverId ?? selectedRow?.serverId ?? null;
    const machine = executionTarget?.machine ?? selectedRow?.machine ?? null;
    // Named as the picker chip names it: same-name machines of one Home carry their disambiguator.
    // The label only appears in copy ("On {machine}", "Install on {machine}"), so a machine whose name
    // is still loading reads "this machine" rather than its placeholder title.
    const machineLabel = machine && serverId
        ? getMachineSentenceName(machine, resolveMachineDisplayNames(targetSelection.pickerRows
            .filter((row) => row.serverId === serverId)
            .map((row) => row.machine)).get(machine.id))
        : machine ? getMachineSentenceName(machine) : null;
    return {
        executionTarget,
        /** Presence comes from the canonical target state, not execution admission. */
        offline: targetSelection.state.kind === 'offline',
        projectionScope: machineId && serverId ? { machineId, serverId } : null,
        machineLabel,
        machineLockedReason: describeMachineLockedReason(machine),
    } as const;
}

export type AgentAdministrationCatalog = Readonly<{
    targetSelection: MachineAdministrationTargetSelectionV1;
    executionTarget: ReturnType<typeof useAgentsMachineScope>['executionTarget'];
    projectionScope: ReturnType<typeof useAgentsMachineScope>['projectionScope'];
    machineOnline: boolean;
    machineLabel: ReturnType<typeof useAgentsMachineScope>['machineLabel'];
    projectionCurrent: boolean;
    declarationProjection?: PluginProjectionV2 | null;
    agentEntries: ReturnType<typeof getResolvedAgentCatalogEntries>;
}>;

/**
 * The Agents collection as the selected administration machine projects it: the canonical target
 * selection, its fresh execution target, the daemon projection phase and the resolved catalog
 * entries. The collection rail and the index page read the same owner so they cannot disagree
 * about which agents exist on the machine. An offline machine keeps its last known projection.
 */
export function useAgentAdministrationCatalog(options?: Readonly<{
    /** `false`: read the machine's cached projection only, never load it (a summary elsewhere). */
    loadProjection?: boolean;
}>): AgentAdministrationCatalog {
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const targetSelection = useAgentsAdministrationTargetSelection();
    const scope = useAgentsMachineScope(targetSelection);
    const { snapshot: acpCatalog } = useAcpCatalogForServer(scope.projectionScope?.serverId
        ?? (targetSelection.selectedTarget === null || targetSelection.selectedTargetServerMatchesActiveAccount
            ? undefined : null));
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: scope.projectionScope?.machineId ?? null,
        serverId: scope.projectionScope?.serverId ?? null,
        enabled: scope.projectionScope !== null,
        load: options?.loadProjection,
    });
    // Same-scope inputs survive refresh and error: they are inert metadata, and every daemon
    // operation stays gated on a live execution target.
    const daemonMergedProjectionInputs = daemonMergedProjection.inputs;
    const agentEntries = React.useMemo(() => getResolvedAgentCatalogEntries({
        enabledAgentIds: [],
        backendEnabledByTargetKey,
        acpCatalogSnapshot: !acpCatalog?.stale ? acpCatalog?.catalog : undefined,
        mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
    }), [acpCatalog, backendEnabledByTargetKey, daemonMergedProjectionInputs]);

    return {
        targetSelection,
        executionTarget: scope.executionTarget,
        projectionScope: scope.projectionScope,
        machineOnline: scope.executionTarget !== null,
        machineLabel: scope.machineLabel,
        projectionCurrent: daemonMergedProjection.phase === 'ready',
        declarationProjection: daemonMergedProjection.phase === 'ready' ? daemonMergedProjectionInputs?.pluginProjectionV2 ?? null : null,
        agentEntries,
    } as const;
}
