import { PluginSourcesScreen } from '@/components/settings/plugins/PluginSourcesScreen';

export const WorkspaceRouteBody = PluginSourcesScreen;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
