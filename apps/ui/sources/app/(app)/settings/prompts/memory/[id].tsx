import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { MemoryDocumentScreen } from '@/components/memory/MemoryDocumentScreen';

export function MemoryDocumentPage() {
  const { id, serverId, topic, fact } = useLocalSearchParams<{ id: string; serverId?: string; topic?: string; fact?: string }>();
  if (!id) return null;
  return <MemoryDocumentScreen artifactId={id} serverId={serverId} topic={topic} factId={fact} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { MemoryDocumentPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={MemoryDocumentPage} />; }
