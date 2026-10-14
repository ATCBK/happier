import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { SKILLS_NEW_ROUTE } from '@/components/settings/skills/skillsCollectionModel';

/** 0.2's new-skill route (P6 §4.9). Removal: when 0.2 links stop being a supported direction. */
export const WorkspaceRouteBody = React.memo(function LegacyNewSkillRoute() {
    const { serverId } = useLocalSearchParams<{ serverId?: string | string[] }>();
    return <Redirect href={{ pathname: SKILLS_NEW_ROUTE, params: { serverId: Array.isArray(serverId) ? serverId[0] : serverId } }} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
