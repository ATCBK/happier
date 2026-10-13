import * as React from 'react';

import { Redirect } from '@/components/appShell/workspace/destinationRoute';
import { SKILLS_COLLECTION_ROUTE } from '@/components/settings/skills/skillsCollectionModel';

/** 0.2's skills list: Skills is its own page now (P6 §4.9). Removal: when 0.2 links stop being a supported direction. */
export const WorkspaceRouteBody = React.memo(function LegacySkillsListRoute() {
    return <Redirect href={SKILLS_COLLECTION_ROUTE as never} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
