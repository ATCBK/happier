import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { AppPaneContext, useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { getOwnDetailsWorkspaceRecordEntry } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import * as React from 'react';
import { useDestinationParams } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readProjectFileRouteTarget, readProjectRouteCompanion, readProjectRouteStringParam, readProjectSelectedRouteResource, serializeProjectInitialResource } from './projectRouteState';
import { createProjectCommitDetailsTab } from './projectDetailsTabBuilders';
import { createSessionPaneDetailsTab } from '@/components/sessions/panes/url/sessionPaneUrlState';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';

function resourceAdmissionKey(scopeId: string, resource: Parameters<typeof serializeProjectInitialResource>[0]): string | null {
    return resource ? `${scopeId}:${JSON.stringify(serializeProjectInitialResource(resource))}` : null;
}

/** Destination-owned admission of the initial resource carried by its route. */
export function useProjectInitialResource(pane: Pick<AppPaneScopeApi, 'scopeId' | 'openDetailsTab' | 'selectRightDestination'>,
    workspaceRef: WorkspaceRefV1 | null): boolean {
    const paneContext = React.useContext(AppPaneContext);
    const routerRef = useProjectRouteRouterRef();
    const params = useDestinationParams<Record<string, string | string[] | undefined>>();
    const fileTarget = readProjectFileRouteTarget(params);
    const commit = readProjectRouteStringParam(params.initialCommit);
    const tab = fileTarget ? createSessionPaneDetailsTab(fileTarget) : commit ? createProjectCommitDetailsTab(commit) : null;
    const resourcePresence = useOptionalAppPaneContext(value => {
        const details = value.state.scopes[pane.scopeId]?.details;
        return { isOpen: details?.isOpen === true,
            hasResource: Boolean(tab && details && getOwnDetailsWorkspaceRecordEntry(details.tabsByKey, tab.key)) };
    });
    const canAdmit = workspaceRef !== null;
    const companion = React.useMemo(() => readProjectRouteCompanion({ right: params.right, rightDestination: params.rightDestination }),
        [params.right, params.rightDestination]);
    const companionKey = companion ? JSON.stringify(companion) : null;
    const lastCompanion = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!canAdmit) return;
        if (!companionKey || !companion) { lastCompanion.current = null; return; }
        const key = `${pane.scopeId}:${companionKey}`;
        if (lastCompanion.current === key) return;
        lastCompanion.current = key;
        // Availability and unavailable selection are still owned by the sidebar registry/host.
        pane.selectRightDestination(typeof companion === 'string' ? { kind: 'builtin', id: companion } : companion);
    }, [canAdmit, companion, companionKey, pane.scopeId, pane.selectRightDestination]);
    const resource = fileTarget ?? (commit ? { kind: 'commit' as const, sha: commit } : null);
    const admissionKey = canAdmit && tab ? resourceAdmissionKey(pane.scopeId, resource) : null;
    const lastAdmitted = React.useRef<string | null>(null);
    React.useEffect(() => {
        // Route resources have no checkout authority until the shared resolver accepts an exact ref.
        if (!canAdmit) return;
        const tab = fileTarget ? createSessionPaneDetailsTab(fileTarget) : commit ? createProjectCommitDetailsTab(commit) : null;
        if (!tab) {
            lastAdmitted.current = null;
            return;
        }
        if (lastAdmitted.current === admissionKey) {
            const details = paneContext?.getSnapshot().state.scopes[pane.scopeId]?.details;
            // A closed resource must no longer address this destination. Otherwise an explicit
            // open of the same URL is indistinguishable from the route we already admitted.
            if (details && (!resourcePresence?.isOpen || !resourcePresence.hasResource)) {
                const selected = readProjectSelectedRouteResource(buildDetailsWorkspaceStateView(details)) ?? null;
                // This tab is already selected. Projecting it must not replay opening side effects
                // such as promoting its preview or resetting the reading anchor.
                lastAdmitted.current = resourceAdmissionKey(pane.scopeId, selected);
                routerRef.current.setParams(serializeProjectInitialResource(selected, fileTarget));
            }
            return;
        }
        lastAdmitted.current = admissionKey;
        pane.openDetailsTab(tab, { intent: fileTarget?.openAs ?? 'pinned' });
        // Retain the qualified resource in the destination URL across phone/Workspace projection.
        // Admission is idempotent while that resource remains in this mounted destination.
    }, [admissionKey, canAdmit, pane.openDetailsTab, pane.scopeId, paneContext, resourcePresence?.isOpen, resourcePresence?.hasResource, routerRef]);
    return admissionKey !== null && lastAdmitted.current !== admissionKey;
}
