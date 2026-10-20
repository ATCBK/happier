import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
const { workspaceListDirectory } = await import('./workspaceFileSystem');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
let serverId: string;

beforeEach(async () => {
    network.resetRequests();
    serverId = (await network.addHome('https://list-directory.test', 'directory-account')).id;
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
});
afterAll(async () => { await network.dispose(); });

describe('workspaceListDirectory', () => {
    it('resolves relative paths against the workspace root through Action admission', async () => {
        const response = { success: true, entries: [{ name: 'a.ts', type: 'file' as const }] };
        network.respond(RPC_METHODS.LIST_DIRECTORY, response);

        await expect(workspaceListDirectory({ machineId: 'machine-1', rootPath: '~/repo', serverId }, 'src'))
            .resolves.toEqual(response);

        expect(network.requests).toContainEqual(expect.objectContaining({
            targetId: 'machine-1', method: RPC_METHODS.LIST_DIRECTORY,
            payload: { rootPath: '~/repo', path: '~/repo/src' },
        }));
    });

    it('returns the remote RPC error code after Action admission', async () => {
        network.setRpcAckResponder(async () => ({
            ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        }));

        await expect(workspaceListDirectory({ machineId: 'machine-1', rootPath: '~/repo', serverId }, 'src'))
            .resolves.toMatchObject({ success: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        expect(network.requests).toContainEqual(expect.objectContaining({ method: RPC_METHODS.LIST_DIRECTORY }));
    });

    it('rejects an unsupported remote response through the current Action output schema', async () => {
        network.respond(RPC_METHODS.LIST_DIRECTORY, null);

        const result = await workspaceListDirectory({ machineId: 'machine-1', rootPath: '~/repo', serverId }, 'src');
        expect(result).toMatchObject({ success: false, errorCode: 'invalid_action_output' });
        expect(network.requests).toContainEqual(expect.objectContaining({ method: RPC_METHODS.LIST_DIRECTORY }));
    });
});
