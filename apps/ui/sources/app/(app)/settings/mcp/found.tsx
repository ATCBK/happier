import { McpDetectedServersScreen as WorkspaceRouteBody } from '@/components/settings/mcpServers/McpDetectedServersScreen';
export { WorkspaceRouteBody };
/** Found uses the existing discovery owner inside the MCP collection. */
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
