import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
const { workspaceStatFile } = await import('./workspaceFileSystem');
const fileReadWrite = await import('./workspaceFileSystem/fileReadWrite');
const pathMetadataMutations = await import('./workspaceFileSystem/pathMetadataMutations');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
let serverId: string;

beforeEach(async () => {
    network.resetRequests();
    serverId = (await network.addHome('https://workspace-stat.test', 'account-stat')).id;
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
});
afterAll(async () => { await network.dispose(); });

describe('workspaceStatFile', () => {
    it('keeps the barrel stat binding in the file read owner and removes the metadata-path export', () => {
        expect(workspaceStatFile).toBe(fileReadWrite.workspaceStatFile);
        expect(pathMetadataMutations).not.toHaveProperty('workspaceStatFile');
    });

    it('exports one file-details stat owner through the workspace filesystem barrel', async () => {
        network.respond(RPC_METHODS.STAT_FILE, { success: true, exists: false });
        await expect(workspaceStatFile(
            { machineId: 'machine-1', rootPath: '~/repo', serverId }, 'src/a.ts',
        )).resolves.toEqual({ success: true, exists: false });
        expect(network.requests).toContainEqual(expect.objectContaining({
            serverUrl: 'https://workspace-stat.test', targetId: 'machine-1', method: RPC_METHODS.STAT_FILE,
            payload: { path: '~/repo/src/a.ts' },
        }));
    });

    it('preserves the transfer stat failure contract through the public barrel', async () => {
        const failure = { success: false, error: 'stat unavailable', errorCode: 'METHOD_NOT_AVAILABLE' };
        network.respond(RPC_METHODS.STAT_FILE, failure);
        await expect(workspaceStatFile(
            { machineId: 'machine-1', rootPath: '~/repo', serverId }, 'src/a.ts',
        )).resolves.toEqual(failure);
    });
});
