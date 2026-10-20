import * as React from 'react';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';

import { WorkflowProjectTargetControl } from '@/components/workflows/editor/WorkflowProjectTargetControl';
import { useAllMachines } from '@/sync/domains/state/storage';
import { isWorkflowProjectTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/**
 * Runs on (04 §5.4, INT §3.1 #9; 07 S4): one machine and folder per trigger set — the set's
 * Automation assignment — chosen through the Where owner's own field. One row, one field select
 * with the where-summary as its value, its consequence as the description; never per trigger.
 */
export function TriggerRunsOnRow(props: Readonly<{
    accountLifetime?: ServerAccountScopeLifetime | null;
    testID: string;
    target: WorkflowProjectTargetV1 | null;
    onChange: (next: WorkflowProjectTargetV1) => void;
    description: string;
}>): React.ReactElement {
    const activeMachines = useAllMachines();
    const addressedMachines = useMachineListForServer(props.accountLifetime?.scope.serverId ?? '');
    const machines = props.accountLifetime === undefined ? activeMachines : addressedMachines ?? [];
    const viewportClass = useViewportClass();
    const machine = props.target === null ? null : machines.find((candidate) => candidate.id === props.target?.machineId) ?? null;
    return (
        <WorkflowProjectTargetControl
            accountLifetime={props.accountLifetime}
            purpose="trigger"
            presentation="field"
            accessoryLayout={viewportClass === 'compact' ? 'stacked' : 'inline'}
            title={t('workflows.triggers.editor.runsOn')}
            subtitle={props.description}
            target={props.target}
            machineName={props.target === null ? null : getMachineDisplayName(machine) ?? t('machine.unnamedMachine')}
            machines={machines}
            onChange={(next) => { if (isWorkflowProjectTarget(next)) props.onChange(next); }}
            testIDPrefix={props.testID}
        />
    );
}
