import * as React from 'react';

import { WorkflowsDestinationIndex } from '@/components/workflows/library/WorkflowsDestinationIndex';

/**
 * The Runs deep link is the destination with its column on Runs: beside the column, main keeps the
 * library (the column is the one Runs list, DESIGN-16 D9); without it, the column-as-page opens on Runs.
 */
export function WorkflowsRunsRoute(): React.ReactElement {
    return <WorkflowsDestinationIndex />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { WorkflowsRunsRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkflowsRunsRoute} />; }
