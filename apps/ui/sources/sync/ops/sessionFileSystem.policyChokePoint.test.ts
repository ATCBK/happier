import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const callGuardedMachineRpcWithPolicyMock = vi.fn();

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (params: unknown) => callGuardedMachineRpcWithPolicyMock(params),
}));

describe('workspaceFileSystem policy choke point', () => {
    it('workspaceGetDirectoryTree routes through the guarded machine RPC boundary', async () => {
        const { workspaceGetDirectoryTree } = await import('./workspaceFileSystem');
        const response = { success: true, tree: { name: 'repo', path: '~/repo', type: 'directory' } };
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce(response);

        await expect(
            workspaceGetDirectoryTree(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                'src',
                3,
            ),
        ).resolves.toEqual(response);

        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            method: RPC_METHODS.GET_DIRECTORY_TREE,
            payload: {
                path: '~/repo/src',
                maxDepth: 3,
            },
        });
    });
});
