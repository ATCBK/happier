import * as React from 'react';

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { MachinesDoorProvider } from '@/components/machines/page/machinesDoor';
import { MachinePageScreen } from '@/components/machines/page/MachinePageScreen';

/** `/machines/<id>`: a machine's page through the rail door (R1), beside the machine list. */
function RailDoorMachinePage() {
    return <MachinesDoorProvider door="rail"><MachinePageScreen /></MachinesDoorProvider>;
}
export { RailDoorMachinePage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={RailDoorMachinePage} />; }
