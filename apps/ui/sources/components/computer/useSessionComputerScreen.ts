import * as React from 'react';

import { useBrowserSessionAgentIdentity } from '@/components/browser/copresence/BrowserShellPresence';
import { noteSessionComputerMachine } from '@/sync/domains/computer/sessionComputerMachines';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

import type { ComputerScreenViewerProps } from './ComputerScreenViewer';
import { computerTargetKey } from './ComputerTargetPicker';
import { openComputerTargetPickerForSession, resolveComputerTargetPickerForSession } from './openComputerTargetPickerForSession';
import type { ComputerTargetPickerRequest } from './showComputerTargetPicker';
import { useComputerScreenStream } from './useComputerScreenStream';
import { useComputerSessionControl } from './useComputerSessionControl';
import { useComputerDriverRepair } from './useComputerDriverRepair';
import { useEscapeTakesControl } from './useEscapeTakesControl';

/**
 * The controlled Computer body model, currently consumed by the Details pane. A shared
 * presentation host must retain this owner when changing shells, not mount another instance.
 */
export function useSessionComputerScreen(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    machineId: string;
    enabled?: boolean;
}>): Omit<ComputerScreenViewerProps, 'compact' | 'testID'> & Readonly<{
    /** The picker request at the person's intent, for a presentation that anchors the picker itself. */
    resolveChooseWindow: () => ComputerTargetPickerRequest | null;
}> {
    const accountLifetime = useSessionViewerSourceAccountLifetime();
    const serverId = props.serverId ?? accountLifetime?.scope.serverId ?? null;
    const identity = useBrowserSessionAgentIdentity({ sessionId: props.sessionId, serverId });
    const scope = React.useMemo(
        () => ({ sessionId: props.sessionId, machineId: props.machineId, serverId }),
        [props.machineId, serverId, props.sessionId],
    );
    const enabled = props.enabled ?? true;
    const control = useComputerSessionControl({ scope, refreshKey: identity.turnActive, enabled, accountLifetime });
    const driverRepair = useComputerDriverRepair(scope, accountLifetime, control.refresh);
    const stream = useComputerScreenStream({
        sessionId: props.sessionId,
        machineId: props.machineId,
        serverId,
        accountLifetime,
        sourceId: control.canRead ? control.selection?.sourceId ?? null : null,
        machineName: control.machineName,
        enabled,
        inputEnabled: control.canInput,
    });
    const streamStatus = stream?.playerState?.phase ?? null;
    const refreshControl = control.refresh;
    // Source availability changes are meaningful; changing image URLs are not status invalidations.
    React.useEffect(() => { if (enabled) refreshControl(); }, [enabled, refreshControl, streamStatus]);

    // Only while the capsule offers Take control: a see-only share or a machine denying input has none.
    const access = control.selection?.access ?? control.selection?.approvalDisplay.access;
    useEscapeTakesControl(enabled && control.presence.kind === 'agent' && access !== 'see' && control.inputDenied !== true, control.takeControl);
    React.useEffect(() => {
        noteSessionComputerMachine({ sessionId: props.sessionId, machineId: props.machineId, machineName: control.machineName });
    }, [control.machineName, props.machineId, props.sessionId]);

    const agent = React.useMemo(() => ({ agentId: identity.agentId, name: identity.name }), [identity.agentId, identity.name]);
    // The machine's presence, when this client holds its row: an unreachable machine is a cause to say.
    const machinePresence = useMachinePresenceSummary(serverId, enabled ? props.machineId : null);
    const machineOnline = machinePresence.reachability === 'unknown' ? undefined : machinePresence.reachability === 'reachable';
    const selectedTarget = control.selection?.selectedTarget ?? null;
    const { applySelection, refresh } = control;
    const pickerParams = React.useCallback(() => ({
        sessionId: props.sessionId,
        serverId,
        accountLifetime,
        machineId: props.machineId,
        machineName: control.machineName ?? props.machineId,
        currentTargetKey: selectedTarget ? computerTargetKey(selectedTarget) : null,
        access: control.selection?.access ?? control.selection?.approvalDisplay.access,
        onSelected: applySelection,
        onStoppedSharing: refresh,
    }), [accountLifetime, applySelection, control.machineName, control.selection?.access, control.selection?.approvalDisplay.access, props.machineId, serverId, props.sessionId, refresh, selectedTarget]);
    const chooseWindow = React.useCallback(() => openComputerTargetPickerForSession(pickerParams()), [pickerParams]);
    const resolveChooseWindow = React.useCallback(() => resolveComputerTargetPickerForSession(pickerParams()), [pickerParams]);

    return {
        agent,
        targetTitle: control.targetTitle,
        appName: control.appName,
        access: control.selection?.access ?? control.selection?.approvalDisplay.access,
        targetKind: control.selection?.approvalDisplay.target?.kind ?? null,
        machineName: control.machineName,
        shared: Boolean(control.selection?.sourceId),
        selectionPending: control.selection === null && control.failure === null,
        inputDenied: control.inputDenied,
        machineOnline,
        grants: control.grants,
        openSettings: control.openSettings,
        onOpenSettings: control.requestSettings,
        onRefresh: control.refresh,
        stream,
        presence: control.presence,
        agentActing: control.agentActing,
        checking: control.busy === 'check',
        stopping: control.busy === 'stop',
        failure: control.failure,
        stopFailed: control.stopFailed,
        onRepairDriver: driverRepair.repair,
        repairingDriver: driverRepair.repairing,
        onTakeControl: control.takeControl,
        onHandBack: control.handBack,
        onCheckAgain: control.checkAgain,
        onChooseWindow: chooseWindow,
        resolveChooseWindow,
        onStopSharing: control.stopSharing,
    };
}
