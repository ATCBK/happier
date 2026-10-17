import * as React from 'react';

import { LocalServicesSurfaceHost } from '@/components/sessions/localServices';
import { createProjectServicePlacementRenderer } from './ProjectServicePlacementControls';
import { ProjectServicePlacementObservationProvider } from './projectServicePlacementObservation';
import { useProjectDefinitionInspection } from '@/components/projects/projectSetup/useProjectDefinitionInspection';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ServiceRowOpenHandler } from '@/components/sessions/localServices/ServiceRowView';
import type { FrontDoorRuntimeActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type {
    LocalServiceLauncherSnapshotClient,
    LocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import type { LocalServicePublicPreviewStatusClient } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';

export type ProjectRightPanelServicesViewProps = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    /** The SOURCE checkout's accepted ref: service placement is saved there, never on a worker copy. */
    workspaceRefId?: string | null;
    workspaceRoot?: string | null;
    inventoryState?: LocalServiceInventoryState;
    launcherState?: LocalServiceLauncherState | null;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
    runtimeActionExecute?: FrontDoorRuntimeActionExecute;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    /** The Services page leads with its purpose; the rail keeps the pane chrome. Same body. */
    presentation?: 'pane' | 'page';
    /** The Project's own way to declare a service; the empty state offers it. */
    onAddService?: () => void;
    testID?: string;
}>;

export function ProjectRightPanelServicesView(props: ProjectRightPanelServicesViewProps = {}): React.ReactElement {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId ?? '');
    const workspace = React.useMemo<WorkspaceAddressV1 | null>(() => props.serverId && props.machineId && props.workspaceRefId && props.workspaceRoot
        ? { serverId: props.serverId, machineId: props.machineId, workspaceId: props.workspaceRefId, rootPath: props.workspaceRoot } : null,
    [props.machineId, props.serverId, props.workspaceRefId, props.workspaceRoot]);
    const inspection = useProjectDefinitionInspection(workspace, binding);
    const declarations = React.useMemo(() => {
        const document = inspection.read && 'value' in inspection.read ? inspection.read.value.definition.document : null;
        const currentnessKey = document?.status === 'valid' ? JSON.stringify(document.manifest) : undefined;
        return document?.status === 'valid' ? Object.fromEntries(Object.entries(document.manifest.services ?? {}).map(([name, service]) =>
            [name, { portable: service.execution === 'portable', currentnessKey }])) : {};
    }, [inspection.read]);
    const placementSource = React.useMemo(() => props.serverId && props.machineId && props.workspaceRefId
        ? { serverId: props.serverId, machineId: props.machineId, refId: props.workspaceRefId } : null,
    [props.machineId, props.serverId, props.workspaceRefId]);
    const renderServicePlacement = React.useMemo(() => createProjectServicePlacementRenderer(placementSource, declarations),
        [declarations, placementSource]);
    const body = (
        <LocalServicesSurfaceHost
            machineId={props.machineId}
            serverId={props.serverId}
            workspaceRoot={props.workspaceRoot}
            workspaceRefId={props.workspaceRefId}
            scope="workspace"
            inventoryState={props.inventoryState}
            launcherState={props.launcherState}
            launcherSnapshotClient={props.launcherSnapshotClient}
            publicPreviewState={props.publicPreviewState}
            publicPreviewStatusClient={props.publicPreviewStatusClient}
            runtimeActionExecute={props.runtimeActionExecute}
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            presentation={props.presentation}
            onAddService={props.onAddService}
            renderServicePlacement={renderServicePlacement}
            testID={props.testID ?? 'project-rightpanel-services'}
        />
    );
    return placementSource ? <ProjectServicePlacementObservationProvider source={placementSource} runtimeActionExecute={props.runtimeActionExecute}>{body}</ProjectServicePlacementObservationProvider> : body;
}
