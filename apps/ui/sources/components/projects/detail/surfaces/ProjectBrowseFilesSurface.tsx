import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import * as React from 'react';

import { resolveOpenDetailsFilePath } from '@/components/workspaces/files/resolveOpenDetailsFilePath';

import { WorkspaceCodeBrowserView, type WorkspaceCodeLocation } from '@/components/projects/files/code/WorkspaceCodeBrowserView';
import { useRepositoryTreeBrowserState } from '@/hooks/workspaces/files/repositoryTreeBrowserState';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { buildWorkspaceFileLink } from '@/utils/url/sessionFileDeepLink';

export const ProjectBrowseFilesSurface = React.memo((props: Readonly<{
    scopeId: string;
    scope: WorkspaceScopeBase;
    workspaceRef: WorkspaceRefV1;
    activeWorktreeId?: string | null;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned: (fullPath: string) => void;
    /** The page route owns back/up and deep-link navigation when mounted as Code. */
    location?: WorkspaceCodeLocation;
    onNavigate?: (location: WorkspaceCodeLocation) => void;
    onOpenHistory?: (location: WorkspaceCodeLocation) => void;
}>) => {
    const pane = useAppPaneScope(props.scopeId);
    const { location, setLocation } = useRepositoryTreeBrowserState(tryBuildWorkspaceCacheKey(props.scope) ?? '');
    // Existing Code routes can restore a file page. New file activations enter the shared opener;
    // the Files companion keeps showing that file's containing folder.
    const companionLocation: WorkspaceCodeLocation = location.kind === 'file'
        ? { kind: 'folder', path: location.path.slice(0, Math.max(0, location.path.lastIndexOf('/'))) }
        : location;
    const onNavigate = React.useCallback((next: WorkspaceCodeLocation) => {
        if (next.kind === 'file') props.onOpenFile(next.path);
        else if (props.onNavigate) props.onNavigate(next);
        else setLocation(next);
    }, [props.onNavigate, props.onOpenFile, setLocation]);
    const fileHref = React.useCallback((path: string) => buildWorkspaceFileLink({ target: {
        kind: 'project', workspaceRefId: props.workspaceRef.id, serverId: props.workspaceRef.serverId,
        machineId: props.scope.machineId, rootPath: props.scope.rootPath }, path }),
    [props.scope.machineId, props.scope.rootPath, props.workspaceRef.id, props.workspaceRef.serverId]);
    const files = pane.scopeState?.right.tabState.files as { revealRequest?: Readonly<{ path: string }> } | undefined;
    // The row of the file open in Details stays selected while its tab is open (lab F1).
    const selectedPath = resolveOpenDetailsFilePath(pane.scopeState?.details);
    return (
        <WorkspaceCodeBrowserView
            paneScopeId={props.scopeId}
            rootLabel={resolveWorkspaceRefDisplayName(props.workspaceRef)}
            location={props.location ?? companionLocation}
            onNavigate={onNavigate}
            onOpenFile={props.onOpenFile}
            onOpenHistory={props.onOpenHistory}
            fileHref={fileHref}
            scope={props.scope}
            onOpenFilePinned={props.onOpenFilePinned}
            onEditFile={props.onOpenFilePinned}
            revealRequest={files?.revealRequest}
            selectedPath={selectedPath}
        />
    );
});
