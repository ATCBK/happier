// A machine's page in the Settings door: the same screen as the rail door's (`/machines/[id]`); only its
// place in navigation differs.
import { MachinePageScreen as WorkspaceRouteBody } from '@/components/machines/page/MachinePageScreen';
export { WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
