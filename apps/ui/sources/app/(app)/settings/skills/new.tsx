import * as React from 'react';

import { SkillDetailScreen } from '@/components/settings/skills/detail/SkillDetailScreen';

/** A new skill's draft beside the Skills list (P6 §4.3: the detail before the skill exists). */
export function NewSkillPage() {
  return <SkillDetailScreen skillId={null} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { NewSkillPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={NewSkillPage} />; }
