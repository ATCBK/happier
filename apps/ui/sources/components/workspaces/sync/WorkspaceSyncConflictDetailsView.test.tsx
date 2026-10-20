import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { readWorkspaceSyncConflictDetailsResource, usesWorkspaceSyncSplitComparison } =
    await import('./WorkspaceSyncConflictDetailsView');

describe('WorkspaceSyncConflictDetailsView resource', () => {
    it('retains only current IDs and the selected path, never replicated root authority', async () => {
        const resource = {
            kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'workspace-a', workspaceRefId: 'workspace-c',
            controllerMachineId: 'machine-a', serverId: 'server-1', initialPath: 'src/tool',
        };
        expect(readWorkspaceSyncConflictDetailsResource(resource)).toEqual(resource);
        expect(readWorkspaceSyncConflictDetailsResource({
            kind: 'workspaceSyncConflicts', relationshipId: 'a-c', controllerMachineId: 'machine-a',
            alpha: { rootPath: '/old' }, beta: { rootPath: '/old' },
        })).toBeNull();
    });
    it('keeps compact comparison navigation until the details pane itself is wide enough', async () => {
        expect(usesWorkspaceSyncSplitComparison(839)).toBe(false);
        expect(usesWorkspaceSyncSplitComparison(840)).toBe(true);
    });
});
