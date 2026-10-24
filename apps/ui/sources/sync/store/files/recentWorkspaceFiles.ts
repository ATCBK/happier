import { recentWorkspaceFilesState } from '@/sync/domains/state/filePaneUiState';
import { recordRecentWorkspaceFile } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';

/** File activation updates only this workspace's MRU, never the settings document. */
export function recordWorkspaceFileOpen(workspaceKey: string, path: string): void {
    const paths = recentWorkspaceFilesState.read(workspaceKey);
    const previous = paths ? { [workspaceKey]: paths } : {};
    const next = recordRecentWorkspaceFile(previous, workspaceKey, path);
    if (next !== previous) recentWorkspaceFilesState.set(workspaceKey, next[workspaceKey]);
}
