import * as React from 'react';
import { useWorkspaceScmStatus, useSetting } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { GitActionRailTooltip } from '@/components/ui/navigation/tabBadge/GitActionRailTooltip';
import { GitActionRailBadge } from '@/components/ui/navigation/tabBadge/GitActionRailBadge';
import type { RailBadgeSignalRenderer } from '@/components/navigation/shell/appRail/AppRailBadge';

// Read the existing summary only; the SCM surface owns refreshing this workspace.
export const ProjectGitActionRailBadge = React.memo((props: Readonly<{ scope: WorkspaceScopeBase; renderSignal?: RailBadgeSignalRenderer }>) => {
    const scmStatus = useWorkspaceScmStatus(props.scope);
    const mode = useSetting('tabBarGitBadgeMode');
    return <GitActionRailBadge scmStatus={scmStatus} mode={mode} renderSignal={props.renderSignal} testID="project-rightpanel-action:git:badge" />;
});

// The tooltip mounts on hover/focus and reads the same scoped cached summary.
export function ProjectGitActionRailTooltip(props: Readonly<{ scope: WorkspaceScopeBase }>) {
    return <GitActionRailTooltip scmStatus={useWorkspaceScmStatus(props.scope)} />;
}
