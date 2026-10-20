import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { AcpBackendEditorScreen } from '@/components/settings/acpCatalog/AcpBackendEditorScreen';
import { isRegistryAgentDefinition, RegistryAgentDetailScreen } from '@/components/settings/agents/detail/RegistryAgentDetailScreen';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';

/**
 * `/settings/agents/custom/<id>`: a saved ACP definition in the Agents collection. A registry agent
 * opens its agent page; a command agent (or `?edit=1`, a registry agent's variables) opens the editor.
 */
export const WorkspaceRouteBody = React.memo(function CustomAcpAgentRoute() {
    const { backendId, edit } = useLocalSearchParams<{ backendId?: string | string[]; edit?: string | string[] }>();
    const id = Array.isArray(backendId) ? backendId[0] : backendId;
    const editing = (Array.isArray(edit) ? edit[0] : edit) === '1';
    const { snapshot } = useAcpCatalog();
    const definition = id ? snapshot?.data?.definitions.find((entry) => entry.id === id) ?? null : null;
    if (!editing && isRegistryAgentDefinition(definition)) {
        return <RegistryAgentDetailScreen key={definition.id} definition={definition} />;
    }
    return <AcpBackendEditorScreen key={id ?? ''} backendId={id ?? null} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
