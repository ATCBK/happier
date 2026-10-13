import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { isMcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { McpServerEditorScreen } from '@/components/settings/mcpServers/McpServerEditorScreen';
import { McpPluginServerDetailPage } from '@/components/settings/mcpServers/detail/McpPluginServerDetailPage';

/** `/settings/mcp/<id>`: a saved MCP server, or a plugin's server (`plugin:<plugin>/<id>`). A different server is a fresh page. */
export const WorkspaceRouteBody = React.memo(function McpServerRoute() {
    const { serverId } = useLocalSearchParams<{ serverId?: string | string[] }>();
    const id = Array.isArray(serverId) ? serverId[0] : serverId;
    if (id && isMcpPluginItemIdV1(id)) return <McpPluginServerDetailPage key={id} itemId={id} />;
    return <McpServerEditorScreen key={id ?? ''} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
