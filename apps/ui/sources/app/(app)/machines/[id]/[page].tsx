import * as React from 'react';

import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { MachinesDoorProvider } from '@/components/machines/page/machinesDoor';
import { MachineSubPageScreen } from '@/components/machines/page/MachineSubPageScreen';

/** `/machines/<id>/<page>`: one of a machine's This machine pages (Sharing, Terminal, Doctor…) through the rail door. */
function RailDoorMachineSubPage() {
    return <MachinesDoorProvider door="rail"><MachineSubPageScreen /></MachinesDoorProvider>;
}
export { RailDoorMachineSubPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={RailDoorMachineSubPage} />; }
