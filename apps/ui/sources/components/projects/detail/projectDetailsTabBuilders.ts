import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';

export { createWorkspaceFileDetailsTab as createProjectFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';

export function createProjectCommitDetailsTab(sha: string): DetailsTab | null {
    const safeSha = sha.trim().split(/\s+/)[0] ?? '';
    if (!safeSha) return null;
    return {
        key: `commit:${safeSha}`,
        kind: 'commit',
        title: safeSha.slice(0, 7),
        resource: { kind: 'commit', sha: safeSha },
    };
}
