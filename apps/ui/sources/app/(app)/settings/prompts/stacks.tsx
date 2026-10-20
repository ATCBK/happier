import * as React from 'react';

import { Redirect } from '@/components/appShell/workspace/destinationRoute';
import { PROMPTS_CONTEXT_ROUTE } from '@/components/settings/prompts/context/promptsContextNavigation';

/**
 * `/settings/prompts/stacks`: the former hub that listed Context, Voice and Profile additions. Context is
 * now the page itself and links the other two, so old links land on it.
 */
export const WorkspaceRouteBody = React.memo(function LegacyPromptStacksRoute() {
    return <Redirect href={PROMPTS_CONTEXT_ROUTE as never} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
