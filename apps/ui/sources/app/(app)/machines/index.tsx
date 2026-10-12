import * as React from 'react';

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { AllMachinesIndex } from '@/components/machines/index/AllMachinesIndex';
import { MachinesDoorProvider } from '@/components/machines/page/machinesDoor';

/**
 * `/machines`: All machines through the rail door (R1). Each rail-door route sets the door itself, so
 * the page is the same whether Expo or a workspace tab hosts it.
 */
function RailDoorMachinesIndex() {
    return <MachinesDoorProvider door="rail"><AllMachinesIndex /></MachinesDoorProvider>;
}
export { RailDoorMachinesIndex as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={RailDoorMachinesIndex} />; }
