import * as React from 'react';

import { Redirect } from '@/components/appShell/workspace/destinationRoute';
import { SKILLS_NEW_ROUTE } from '@/components/settings/skills/skillsCollectionModel';

/** 0.2's new-skill route (P6 §4.9). Removal: when 0.2 links stop being a supported direction. */
export const WorkspaceRouteBody = React.memo(function LegacyNewSkillRoute() {
    return <Redirect href={SKILLS_NEW_ROUTE as never} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
