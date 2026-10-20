import React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { createWorkflowRunRoute, readWorkflowRunTarget } from '@/sync/domains/workflows/workflowRunRoute';

export function AutomationRunDetailRoute() {
    const params = useLocalSearchParams<{ id?: string | string[]; runId?: string | string[]; serverId?: string | string[] }>();
    const target = readWorkflowRunTarget({ target: 'occurrence', automationId: params.id, runId: params.runId });
    return <Redirect href={target ? createWorkflowRunRoute(target, readSessionRouteServerId(params)) : '/workflows'} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { AutomationRunDetailRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={AutomationRunDetailRoute} />; }
