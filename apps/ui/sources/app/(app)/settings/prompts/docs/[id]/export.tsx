import * as React from 'react';
import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

export function ExportPromptDocPage() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    serverId?: string | string[];
  }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const serverId = Array.isArray(params.serverId) ? params.serverId[0] : params.serverId;
  return <Redirect href={id ? { pathname: '/settings/prompts/docs/[id]', params: { id, serverId } }
    : { pathname: '/settings/prompts/docs', params: { serverId } }} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { ExportPromptDocPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ExportPromptDocPage} />; }
