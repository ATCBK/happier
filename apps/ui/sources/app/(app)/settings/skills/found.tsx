import { SkillsFoundScreen as WorkspaceRouteBody } from '@/components/settings/skills/found/SkillsFoundScreen';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
