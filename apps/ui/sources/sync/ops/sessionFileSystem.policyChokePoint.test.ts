import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

const network = await installSessionOpsNetworkBoundary();
const { workspaceGetDirectoryTree } = await import('./workspaceFileSystem');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
let serverId: string;
let accountId: string;
let serverUrl: string;
const executed: Array<{ input: unknown; machineId: string }> = [];
const TREE_ACTION = 'daemon.filesystem.getDirectoryTree' as const;

beforeEach(async () => {
    network.resetRequests();
    executed.length = 0;
    const home = await network.addHome('https://directory-tree.test', 'directory-account', { serverIdentityId: 'srv_directory_tree' });
    serverId = home.id; accountId = home.accountId; serverUrl = home.serverUrl;
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
});
afterAll(async () => { await network.dispose(); });

describe('workspaceFileSystem policy choke point', () => {
    it('reads the exact Machine tree through real Action admission', async () => {
        const response = { success: true, tree: { name: 'repo', path: '~/repo', type: 'directory' } };
        // Filesystem Actions are admitted through the Account external-Action HTTP carrier; the Machine RPC is the far side of it.
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: 'srv_directory_tree', accountId,
            machineId: 'machine-1', actionId: TREE_ACTION, tokenEpoch: 0,
            execute: async (input, context) => { executed.push({ input, machineId: context.target.machineId }); return response; } });
        network.setHttpResponder(async (input, init) => await boundary.handle(new URL(String(input)), init));

        await expect(
            workspaceGetDirectoryTree(
                { machineId: 'machine-1', rootPath: '~/repo', serverId },
                'src',
                3,
            ),
        ).resolves.toEqual(response);

        expect(executed).toContainEqual({ machineId: 'machine-1', input: { rootPath: '~/repo', path: '~/repo/src', maxDepth: 3 } });
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
