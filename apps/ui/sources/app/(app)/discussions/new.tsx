import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { DiscussionRouteScreen } from '@/components/discussions/DiscussionRouteScreen';

export function NewDiscussionRoute() {
    return <DiscussionRouteScreen kind="new" />;
}

export { NewDiscussionRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewDiscussionRoute} />; }
