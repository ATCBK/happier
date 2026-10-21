import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

const network = await installSessionOpsNetworkBoundary();
const { workspaceListDirectory } = await import('./workspaceFileSystem');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
let serverId: string;
let accountId: string;
let serverUrl: string;
let serverIdentityId: string | undefined;
const executed: Array<{ input: unknown; machineId: string }> = [];

/** Filesystem Actions are admitted through the Account external-Action HTTP carrier; the Machine RPC is the far side of it. */
async function serveListDirectory(execute: (input: unknown) => unknown, failure?: (result: unknown) => { errorCode: string; error: string } | null) {
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: serverIdentityId!, accountId,
        machineId: 'machine-1', actionId: 'daemon.filesystem.listDirectory', tokenEpoch: 0, ...(failure ? { failure } : {}),
        execute: async (input, context) => {
            executed.push({ input, machineId: context.target.machineId });
            return await execute(input);
        } });
    network.setHttpResponder(async (input, init) => await boundary.handle(new URL(String(input)), init));
}

beforeEach(async () => {
    network.resetRequests();
    executed.length = 0;
    const home = await network.addHome('https://list-directory.test', 'directory-account', { serverIdentityId: 'srv_list_directory' });
    serverId = home.id; accountId = home.accountId; serverUrl = home.serverUrl; serverIdentityId = 'srv_list_directory';
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
});
afterAll(async () => { await network.dispose(); });

describe('workspaceListDirectory', () => {
    it('resolves relative paths against the workspace root through Action admission', async () => {
        const response = { success: true, entries: [{ name: 'a.ts', type: 'file' as const }] };
        await serveListDirectory(() => response);

        await expect(workspaceListDirectory({ machineId: 'machine-1', rootPath: '~/repo', serverId }, 'src'))
            .resolves.toEqual(response);

        expect(executed).toContainEqual({ machineId: 'machine-1', input: { rootPath: '~/repo', path: '~/repo/src' } });
    });

    it('returns the remote RPC error code after Action admission', async () => {
        await serveListDirectory(() => ({ success: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
            result => (result as { success?: boolean }).success === false
                ? { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' } : null);

        await expect(workspaceListDirectory({ machineId: 'machine-1', rootPath: '~/repo', serverId }, 'src'))
            .resolves.toMatchObject({ success: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        expect(executed).toHaveLength(1);
    });

    it('rejects an unsupported remote response through the current Action output schema', async () => {
        await serveListDirectory(() => null);

        const result = await workspaceListDirectory({ machineId: 'machine-1', rootPath: '~/repo', serverId }, 'src');
        expect(result).toMatchObject({ success: false, errorCode: 'invalid_action_output' });
        expect(executed).toHaveLength(1);
    });
});
