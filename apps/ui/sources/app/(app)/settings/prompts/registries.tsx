import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

/** 0.2's registries screen: browsing registries is now Add a skill → Browse (P6 §4.9). */
export const WorkspaceRouteBody = React.memo(function LegacyPromptRegistriesRoute() {
    const { serverId } = useLocalSearchParams<{ serverId?: string | string[] }>();
    return <Redirect href={{ pathname: '/settings/skills', params: { add: 'browse', serverId: Array.isArray(serverId) ? serverId[0] : serverId } }} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
