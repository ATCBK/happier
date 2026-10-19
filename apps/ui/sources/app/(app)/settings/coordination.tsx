import { CoordinationSettingsView } from '@/components/settings/coordination/CoordinationSettingsView';

export const WorkspaceRouteBody = CoordinationSettingsView;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
