import { PublicProfileSettingsScreen } from '@/components/settings/account/publicProfile/PublicProfileSettingsScreen';

export const WorkspaceRouteBody = PublicProfileSettingsScreen;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
