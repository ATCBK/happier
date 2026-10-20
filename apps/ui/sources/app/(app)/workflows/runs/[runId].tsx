import React from 'react';

import { WorkflowsGate } from '@/components/workflows/gating/WorkflowsGate';
import { WorkflowRunScreen } from '@/components/workflows/screens/WorkflowRunScreen';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { readWorkflowRunTarget } from '@/sync/domains/workflows/workflowRunRoute';

/**
 * The exact typed Run route: `/workflows/runs/<runId>`.
 *
 * This is the destination a `workflow_run_update` notification tap, a list row
 * and an agent result all address. The declared target selects the managed or
 * occurrence reader before I/O; the optional Home qualifier scopes either one.
 */
export function WorkflowRunDetailRoute() {
    const params = useLocalSearchParams();
    const target = readWorkflowRunTarget(params);
    return (
        <WorkflowsGate surface={target?.kind === 'occurrence' ? 'occurrence' : 'workflow'}>
            <WorkflowRunScreen />
        </WorkflowsGate>
    );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { WorkflowRunDetailRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkflowRunDetailRoute} />; }
