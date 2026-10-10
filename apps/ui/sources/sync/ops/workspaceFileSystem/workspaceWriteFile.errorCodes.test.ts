import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const filesystem = vi.hoisted(() => ({ response: {} as unknown }));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: async () => filesystem.response,
}));

describe('workspaceWriteFile (workspaceFileSystem)', () => {
    let serverId: string;
    beforeEach(async () => {
        await homes.reset();
        await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Write Home', serverUrl: 'https://write-error.test', accountId: 'account-a' });
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://write-error.test')!.token! });
    });
    afterEach(async () => {
        await standardCleanup();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await homes.reset();
    });

    it('preserves METHOD_NOT_FOUND so callers can treat it as unsupported', async () => {
        const { workspaceWriteFile } = await import('./fileReadWrite');

        filesystem.response = {
            success: false,
            error: 'Method not found',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        };

        const res = await workspaceWriteFile(
            { machineId: 'm1', rootPath: '/repo', serverId },
            'src/a.ts',
            'hello',
        );

        expect(res).toEqual({
            success: false,
            error: 'Method not found',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });
    });
});
