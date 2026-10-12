import * as React from 'react';
import { MACHINE_BUILTIN_WIDGET_IDS_V1, type MachineBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';

import type { MachineWidgetBodyProps } from './machineWidgetKit';
import { MachineVitalsWidget } from './MachineVitalsWidget';
import { MachineFleetWidget } from './MachineFleetWidget';
import { MachineMetricWidget } from './MachineMetricWidget';
import { MachineTopConsumersWidget } from './MachineTopConsumersWidget';
import { MachineLeftBehindWidget } from './MachineLeftBehindWidget';
import { MachineStorageWidget } from './MachineStorageWidget';
import { MachineWorktreesWidget } from './MachineWorktreesWidget';
import { MachineGuardWidget } from './MachineGuardWidget';
import { MachineActivityWidget } from './MachineActivityWidget';
import { MachineSuggestionWidget } from './MachineSuggestionWidget';

/** The one body per Machine builtin definition; ids are the descriptor owner's. */
const MACHINE_WIDGET_BODIES: Readonly<Record<MachineBuiltinWidgetIdV1, React.ComponentType<MachineWidgetBodyProps>>> = {
    machine_vitals: MachineVitalsWidget,
    machine_fleet: MachineFleetWidget,
    machine_metric: MachineMetricWidget,
    machine_top_consumers: MachineTopConsumersWidget,
    machine_left_behind: MachineLeftBehindWidget,
    machine_storage: MachineStorageWidget,
    machine_worktrees: MachineWorktreesWidget,
    machine_guard: MachineGuardWidget,
    machine_activity: MachineActivityWidget,
    machine_cleanup_suggestion: MachineSuggestionWidget,
};

const MACHINE_WIDGET_IDS: ReadonlySet<string> = new Set(MACHINE_BUILTIN_WIDGET_IDS_V1);

export function isMachineBuiltinWidgetId(id: string): id is MachineBuiltinWidgetIdV1 {
    return MACHINE_WIDGET_IDS.has(id);
}

/**
 * Mounted by the generic builtin dispatch for every Machine widget occurrence (Home, groups, the All
 * machines dashboard, a Companion or Board). Each body reads only the owner hooks the Machine page tabs use.
 */
export function MachineWidgetBody(props: MachineWidgetBodyProps & Readonly<{ id: MachineBuiltinWidgetIdV1 }>) {
    const Body = MACHINE_WIDGET_BODIES[props.id];
    return <Body input={props.input} serverId={props.serverId} testID={props.testID} />;
}
