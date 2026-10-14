import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { SKILLS_COLLECTION_ROUTE } from '@/components/settings/skills/skillsCollectionModel';

/** A 0.2 skill file route: files open in place on the skill's page now (P6 §4.9). Removal: when 0.2 links stop being a supported direction. */
export const WorkspaceRouteBody = React.memo(function LegacySkillFileRoute() {
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[] }>();
    const id = Array.isArray(params.id) ? params.id[0] : params.id;
    const serverId = Array.isArray(params.serverId) ? params.serverId[0] : params.serverId;
    return <Redirect href={id
        ? { pathname: '/settings/skills/[skillId]', params: { skillId: id, serverId } }
        : { pathname: SKILLS_COLLECTION_ROUTE, params: { serverId } }} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
