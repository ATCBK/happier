import { SkillsSettingsIndex as WorkspaceRouteBody } from '@/components/settings/skills/SkillsHomepage';
export { WorkspaceRouteBody };
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
