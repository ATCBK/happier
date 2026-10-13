import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { SKILLS_COLLECTION_ROUTE, skillHref } from '@/components/settings/skills/skillsCollectionModel';

/** A 0.2 skill file route: files open in place on the skill's page now (P6 §4.9). Removal: when 0.2 links stop being a supported direction. */
export const WorkspaceRouteBody = React.memo(function LegacySkillFileRoute() {
    const { id } = useLocalSearchParams<{ id?: string }>();
    return <Redirect href={(id ? skillHref(id) : SKILLS_COLLECTION_ROUTE) as never} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
