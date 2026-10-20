import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { DiscussionRouteScreen } from '@/components/discussions/DiscussionRouteScreen';

export function DiscussionsRoute() {
    return <DiscussionRouteScreen kind="list" />;
}

export { DiscussionsRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={DiscussionsRoute} />; }
