import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { DaemonFilesystemListDirectoryRequestSchema } from '@happier-dev/protocol/machines/fileBrowser';
import { useWorkspaceRepositoryTreeBrowser } from './useWorkspaceRepositoryTreeBrowser';
import { clearCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';

type RpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const directoryRpc = vi.hoisted(() => vi.fn<(request: RpcRequest) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(directoryRpc);
});

describe('useWorkspaceRepositoryTreeBrowser', () => {
    it('reloads the mounted real tree after its qualified workspace directory cache is cleared', async () => {
        const scope = { serverId: 'reload-home', machineId: 'm1', rootPath: '/reload-repo' };
        let name = 'before.ts';
        directoryRpc.mockImplementation(async request => {
            const input = DaemonFilesystemListDirectoryRequestSchema.parse(request.payload);
            return { ok: true, path: input.path, truncated: false, entries: [
                { name, path: `${input.path}/${name}`, type: 'file' },
            ] };
        });
        const hook = await renderHook(() => useWorkspaceRepositoryTreeBrowser({ scope, enabled: true }));
        await vi.waitFor(() => expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['before.ts']));
        expect(directoryRpc).toHaveBeenCalledWith(expect.objectContaining({ serverId: scope.serverId,
            machineId: scope.machineId, payload: expect.objectContaining({ path: scope.rootPath }) }));
        name = 'after.ts';
        await act(async () => clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey: buildWorkspaceCacheKey(scope) }));
        await vi.waitFor(() => expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['after.ts']));
        await hook.unmount();
    });
});
