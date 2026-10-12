// A page "This machine" pushes, in the Settings door (the rail door shows the same screen).
import { MachineSubPageScreen as WorkspaceRouteBody } from '@/components/machines/page/MachineSubPageScreen';
export { WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
