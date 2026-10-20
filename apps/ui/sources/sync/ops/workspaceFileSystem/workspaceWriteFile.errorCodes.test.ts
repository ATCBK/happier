import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const filesystem = vi.hoisted(() => ({ response: {} as unknown, requests: [] as unknown[] }));

// The daemon transport is the boundary; filesystem admission and its guarded
// RPC owner remain real so the error travels through the public Action path.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: unknown) => { filesystem.requests.push(request); return filesystem.response; },
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const { workspaceWriteFile } = await import('./fileReadWrite');

describe('workspaceWriteFile (workspaceFileSystem)', () => {
    let serverId: string;
    beforeEach(async () => {
        filesystem.requests.length = 0;
        await homes.reset();
        await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Write Home', serverUrl: 'https://write-error.test', accountId: 'account-a', currentAccount: true });
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
            kind: 'unsupported',
        });
    });

    it.each([
        ['hash_mismatch', 'conflict'], ['expected_file_missing', 'conflict'], ['expected_file_absent', 'conflict'],
        [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, 'unreachable'], [RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, 'unreachable'],
        [MACHINE_RPC_TIMEOUT_ERROR_CODE, 'unreachable'], ['machine_carrier_unavailable', 'unreachable'], ['EACCES', 'failed'],
    ])('classifies %s once at the write boundary', async (errorCode, kind) => {
        filesystem.response = { success: false, error: 'Write refused', errorCode };
        expect(await workspaceWriteFile({ machineId: 'm1', rootPath: '/repo', serverId }, 'a.txt', 'hello'))
            .toMatchObject({ success: false, errorCode, kind });
    });

    it('writes exact binary bytes for guarded restore Undo without UTF-8 re-encoding', async () => {
        filesystem.response = { success: true, hash: 'a'.repeat(64) };
        const bytes = new Uint8Array([0, 255, 128, 13, 10]);
        expect(await workspaceWriteFile({ machineId: 'm1', rootPath: '/repo', serverId }, 'image.bin', bytes, 'b'.repeat(64)))
            .toMatchObject({ success: true, hash: 'a'.repeat(64) });
        expect(filesystem.requests).toEqual(expect.arrayContaining([expect.objectContaining({
            payload: expect.objectContaining({ content: 'AP+ADQo=', expectedHash: 'b'.repeat(64) }),
        })]));
    });
});
