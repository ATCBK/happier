import * as React from 'react';

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { MachinesDoorProvider } from '@/components/machines/page/machinesDoor';
import { ManagedMachineDetailScreen } from '@/components/settings/machines/managed/ManagedMachineDetail';

/** `/machines/managed/<id>`: a machine Happier is still creating, through the rail door. */
function RailDoorManagedMachine() {
    return <MachinesDoorProvider door="rail"><ManagedMachineDetailScreen /></MachinesDoorProvider>;
}
export { RailDoorManagedMachine as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={RailDoorManagedMachine} />; }
