import { SkillsChooseScreen as WorkspaceRouteBody } from '@/components/settings/skills/firstRun/SkillsChooseScreen';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
