import * as React from 'react';
import type { WorkspaceSyncLegacyStateInspectionV1 } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useAllMachines } from '@/sync/domains/state/storage';
import { inspectWorkspaceSyncLegacyState } from '@/sync/ops/workspaceSync';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { invokeDesktopHost, isDesktopHost } from '@/utils/platform/desktopHost';
import {
    getVersionSupportState,
    MINIMUM_CLI_WORKSPACE_SYNC_LEGACY_INSPECT_VERSION,
} from '@/utils/system/versionUtils';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@/sync/runtime/rpcErrors';

type Finding = Readonly<{
    machineId: string;
    machineName: string;
    inspection: Exclude<WorkspaceSyncLegacyStateInspectionV1, { status: 'absent' }>;
}>;

function isInspectionRpcUnavailableError(error: unknown): boolean {
    return isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error);
}

/**
 * Distinguishes a daemon that predates the workspace-sync legacy-state
 * inspection RPC from a genuine detector failure. The typed RPC rejection is
 * the direct capability evidence; the machine's daemon CLI version is the
 * existing corroborating evidence when the daemon could not answer at all.
 */
function isOutdatedDaemonEvidence(
    machine: { daemonState?: unknown } | undefined,
    error: unknown,
): boolean {
    if (isInspectionRpcUnavailableError(error)) return true;
    const version = machine?.daemonState && typeof machine.daemonState === 'object'
        ? (machine.daemonState as { cliVersion?: unknown }).cliVersion
        : null;
    return getVersionSupportState(
        typeof version === 'string' ? version : undefined,
        MINIMUM_CLI_WORKSPACE_SYNC_LEGACY_INSPECT_VERSION,
    ) === 'unsupported';
}

export const WorkspaceSyncLegacyStateRecovery = React.memo(function WorkspaceSyncLegacyStateRecovery() {
    const machines = useAllMachines();
    const localDaemon = useLocalDaemonControl();
    const [findings, setFindings] = React.useState<readonly Finding[]>([]);
    const [outdatedMachineIds, setOutdatedMachineIds] = React.useState<readonly string[]>([]);
    const [checking, setChecking] = React.useState(false);
    const [inspectionFailed, setInspectionFailed] = React.useState(false);
    const inspectionRequestRef = React.useRef<{ controller: AbortController; pending: boolean } | null>(null);

    const inspect = React.useCallback(async () => {
        inspectionRequestRef.current?.controller.abort();
        const request = { controller: new AbortController(), pending: true };
        inspectionRequestRef.current = request;
        setChecking(true);
        const outdated: string[] = [];
        const settled = await Promise.allSettled(machines.map(async (machine): Promise<Finding | null> => {
            const inspection = await inspectWorkspaceSyncLegacyState({ controllerMachineId: machine.id,
                signal: request.controller.signal });
            return inspection.status === 'absent' ? null : {
                machineId: machine.id,
                machineName: getMachineDisplayName(machine) ?? machine.id,
                inspection,
            };
        }));
        if (request.controller.signal.aborted || inspectionRequestRef.current !== request) return;
        request.pending = false;
        setFindings((previous) => {
            const next = new Map(
                previous
                    .filter((finding) => machines.some((machine) => machine.id === finding.machineId))
                    .map((finding) => [finding.machineId, finding] as const),
            );
            settled.forEach((result, index) => {
                const machine = machines[index];
                if (!machine || result.status === 'rejected') return;
                if (result.value) next.set(machine.id, result.value);
                else next.delete(machine.id);
            });
            return [...next.values()];
        });
        settled.forEach((result, index) => {
            const machine = machines[index];
            if (!machine || result.status !== 'rejected') return;
            if (isOutdatedDaemonEvidence(machine, result.reason)) outdated.push(machine.id);
        });
        setOutdatedMachineIds(outdated);
        setInspectionFailed(settled.some((result, index) => (
            result.status === 'rejected'
            && machines[index]
            && !outdated.includes(machines[index]!.id)
        )));
        setChecking(false);
    }, [machines]);

    const reinspect = React.useCallback(() => {
        if (inspectionRequestRef.current?.pending && !inspectionRequestRef.current.controller.signal.aborted) return;
        void inspect();
    }, [inspect]);

    React.useEffect(() => {
        void inspect();
        return () => inspectionRequestRef.current?.controller.abort();
    }, [inspect]);

    if (!checking && findings.length === 0 && outdatedMachineIds.length === 0 && !inspectionFailed) return null;
    return (
        <ItemGroup
            title={t('workspaceSync.legacyRecovery.title')}
            description={t('workspaceSync.legacyRecovery.footer')}
        >
            {checking ? <Item title={t('workspaceSync.legacyRecovery.checking')} showChevron={false} /> : null}
            {outdatedMachineIds.map((machineId) => {
                const outdated = machines.find((machine) => machine.id === machineId);
                return (
                <Item
                    key={machineId}
                    testID={`workspace-sync-legacy-outdated-${machineId}`}
                    title={t('workspaceSync.legacyRecovery.outdatedTitle', { machine: outdated ? getMachineSentenceName(outdated) : machineId })}
                    subtitle={t('workspaceSync.legacyRecovery.outdatedBody')}
                    subtitleLines={0}
                    showChevron={false}
                />
                );
            })}
            {inspectionFailed ? (
                <Item
                    testID="workspace-sync-legacy-inspection-failed"
                    title={t('workspaceSync.legacyRecovery.inspectFailed')}
                    showChevron={false}
                />
            ) : null}
            {findings.map((finding) => {
                const inspection = finding.inspection;
                if (inspection.status === 'legacy_workspace_sync_state_unknown') {
                    return (
                        <Item
                            key={finding.machineId}
                            title={finding.machineName}
                            subtitle={t('workspaceSync.legacyRecovery.unknown', { path: inspection.path, reason: inspection.reason })}
                            subtitleLines={0}
                            copy={inspection.path}
                            showChevron={false}
                        />
                    );
                }
                const canOpen = isDesktopHost() && localDaemon.status?.machineId === finding.machineId;
                return (
                    <React.Fragment key={finding.machineId}>
                        <Item
                            title={finding.machineName}
                            subtitle={t('workspaceSync.legacyRecovery.explanation')}
                            subtitleLines={0}
                            showChevron={false}
                        />
                        <Item
                            testID={`workspace-sync-legacy-quarantine-${finding.machineId}`}
                            title={t('workspaceSync.legacyRecovery.quarantinePath')}
                            subtitle={inspection.quarantinePath}
                            subtitleLines={0}
                            copy={inspection.quarantinePath}
                            showChevron={false}
                        />
                        {canOpen ? (
                            <Item
                                testID={`workspace-sync-legacy-open-${finding.machineId}`}
                                title={t('workspaceSync.legacyRecovery.openFolder')}
                                onPress={() => { void invokeDesktopHost('system_tasks_open_log_path', { path: inspection.quarantinePath }); }}
                            />
                        ) : null}
                        <Item
                            testID={`workspace-sync-legacy-offline-${finding.machineId}`}
                            title={t('workspaceSync.legacyRecovery.offlineTitle')}
                            subtitle={t('workspaceSync.legacyRecovery.offlineSteps', { path: inspection.quarantinePath })}
                            subtitleLines={0}
                            copy={inspection.quarantinePath}
                            showChevron={false}
                        />
                    </React.Fragment>
                );
            })}
            <Item
                testID="workspace-sync-legacy-reinspect"
                title={t('workspaceSync.legacyRecovery.reinspect')}
                onPress={reinspect}
                loading={checking}
                disabled={checking}
            />
        </ItemGroup>
    );
});
