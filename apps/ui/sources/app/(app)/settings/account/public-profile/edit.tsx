import { PublicProfileEditorScreen } from '@/components/settings/account/publicProfile/PublicProfileEditorScreen';

export const WorkspaceRouteBody = PublicProfileEditorScreen;
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
