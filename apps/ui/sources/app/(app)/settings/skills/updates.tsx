import { SkillsUpdatesScreen as WorkspaceRouteBody } from '@/components/settings/skills/updates/SkillsUpdatesScreen';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
