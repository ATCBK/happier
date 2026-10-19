import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
const { workspaceGetDirectoryTree } = await import('./workspaceFileSystem');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
let serverId: string;
const TREE_ACTION = 'daemon.filesystem.getDirectoryTree';

beforeEach(async () => {
    network.resetRequests();
    serverId = (await network.addHome('https://directory-tree.test', 'directory-account')).id;
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
});
afterAll(async () => { await network.dispose(); });

describe('workspaceFileSystem policy choke point', () => {
    it('reads the exact Machine tree through real Action admission', async () => {
        const response = { success: true, tree: { name: 'repo', path: '~/repo', type: 'directory' } };
        network.respond(TREE_ACTION, response);

        await expect(
            workspaceGetDirectoryTree(
                { machineId: 'machine-1', rootPath: '~/repo', serverId },
                'src',
                3,
            ),
        ).resolves.toEqual(response);

        expect(network.requests).toContainEqual(expect.objectContaining({
            serverUrl: 'https://directory-tree.test',
            targetId: 'machine-1',
            method: TREE_ACTION,
            payload: {
                rootPath: '~/repo',
                path: '~/repo/src',
                maxDepth: 3,
            },
        }));
    });

    it('enforces Account Action policy before any Machine RPC leaves the process', async () => {
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            [TREE_ACTION]: { enabled: false },
        } });
        network.setHttpResponder(async rawUrl => new URL(String(rawUrl)).pathname === '/v2/account/settings'
            ? Response.json({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 2 })
            : null);
        await expect(workspaceGetDirectoryTree({ machineId: 'machine-1', rootPath: '~/repo', serverId }, 'src', 3))
            .resolves.toMatchObject({ success: false, errorCode: 'action_disabled' });
        expect(network.requests).toEqual([]);
    });
});
