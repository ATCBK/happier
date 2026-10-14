import * as React from 'react';
import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { MCP_COLLECTION_ROUTE, MCP_NEW_SERVER_ROUTE, mcpServerRoute } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';

function readParam(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * `/settings/mcp-server?serverId=…|addMode=…`: the former stand-alone editor. Servers are edited inside the MCP
 * collection and added in its Add modal now; old links land on the same server or the matching Add mode.
 */
export const WorkspaceRouteBody = React.memo(function LegacyMcpServerEditorRoute() {
    const params = useLocalSearchParams<{ serverId?: string | string[]; addMode?: string | string[] }>();
    const serverId = readParam(params.serverId);
    const addMode = readParam(params.addMode);
    const href = serverId
        ? mcpServerRoute(serverId)
        : addMode === 'import-json'
            ? `${MCP_COLLECTION_ROUTE}?add=paste`
            : addMode === 'quick-install'
                ? `${MCP_COLLECTION_ROUTE}?add=catalog`
                : MCP_NEW_SERVER_ROUTE;
    return <Redirect href={href as never} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
