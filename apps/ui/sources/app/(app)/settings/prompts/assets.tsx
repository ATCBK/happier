import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { SKILLS_FOUND_ROUTE } from '@/components/settings/skills/found/foundSkillsModel';

/** 0.2's external-assets route: the skills those folders held are now "Found on your machines" (P6 §4.9). */
export const WorkspaceRouteBody = React.memo(function LegacyPromptAssetsRoute() {
    const { serverId } = useLocalSearchParams<{ serverId?: string | string[] }>();
    return <Redirect href={{ pathname: SKILLS_FOUND_ROUTE, params: { serverId: Array.isArray(serverId) ? serverId[0] : serverId } }} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
