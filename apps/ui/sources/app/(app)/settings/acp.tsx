import * as React from 'react';
import { Redirect } from '@/components/appShell/workspace/destinationRoute';

/**
 * Older links to the stand-alone ACP backends page. Custom ACP agents are listed and edited in the
 * Agents collection, so this opens it there.
 */
export const WorkspaceRouteBody = React.memo(function AcpCatalogSettingsRoute() {
    return <Redirect href={'/(app)/settings/agents' as never} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
