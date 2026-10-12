import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import * as React from 'react';
import { useDestinationParams } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readProjectFileRouteTarget, readProjectRouteCompanion, readProjectRouteStringParam } from './projectRouteState';
import { serializeFileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import { createProjectCommitDetailsTab, createProjectFileDetailsTab } from './projectDetailsTabBuilders';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

/** Destination-owned admission of the initial resource carried by its route. */
export function useProjectInitialResource(pane: AppPaneScopeApi, workspaceRef: WorkspaceRefV1 | null): boolean {
    const params = useDestinationParams<Record<string, string | string[] | undefined>>();
    const fileTarget = readProjectFileRouteTarget(params);
    const file = fileTarget?.path;
    const anchorKey = fileTarget?.anchor ? JSON.stringify(serializeFileTargetAnchor(fileTarget.anchor, fileTarget.anchorSource)) : '';
    const commit = readProjectRouteStringParam(params.initialCommit);
    const tab = file ? createProjectFileDetailsTab(file, fileTarget?.anchor, fileTarget?.anchorSource) : commit ? createProjectCommitDetailsTab(commit) : null;
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
    const admissionKey = canAdmit && tab ? `${pane.scopeId}:${tab.key}:${anchorKey}` : null;
    const lastAdmitted = React.useRef<string | null>(null);
    React.useEffect(() => {
        // Route resources have no checkout authority until the shared resolver accepts an exact ref.
        if (!canAdmit) return;
        const tab = file ? createProjectFileDetailsTab(file, fileTarget?.anchor, fileTarget?.anchorSource) : commit ? createProjectCommitDetailsTab(commit) : null;
        if (!tab) {
            lastAdmitted.current = null;
            return;
        }
        const admissionKey = `${pane.scopeId}:${tab.key}:${anchorKey}`;
        if (lastAdmitted.current === admissionKey) return;
        lastAdmitted.current = admissionKey;
        pane.openDetailsTab(tab, { intent: 'pinned' });
        // Retain the qualified resource in the destination URL across phone/Workspace projection.
        // Admission is idempotent within this mounted destination, not a destructive query consume.
    }, [anchorKey, canAdmit, commit, file, pane.openDetailsTab, pane.scopeId]);
    return admissionKey !== null && lastAdmitted.current !== admissionKey;
}
