import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { SkillDetailScreen } from '@/components/settings/skills/detail/SkillDetailScreen';

/** A skill beside the Skills list (P6 §4.3). */
export function SkillDetailPage() {
  const { skillId } = useLocalSearchParams<{ skillId: string }>();
  if (!skillId) return null;
  return <SkillDetailScreen key={skillId} skillId={skillId} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { SkillDetailPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SkillDetailPage} />; }
