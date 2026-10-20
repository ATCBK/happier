import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const filesystem = vi.hoisted(() => ({ response: {} as unknown, requests: [] as unknown[] }));

// Home HTTP and the receiving Machine filesystem are boundaries; the real
// captured Account transport validates authorization and invocation encryption.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const { workspaceWriteFile } = await import('./fileReadWrite');

describe('workspaceWriteFile (workspaceFileSystem)', () => {
    let serverId: string;
    beforeEach(async () => {
        filesystem.requests.length = 0;
        await homes.reset();
        await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Write Home', serverUrl: 'https://write-error.test',
            serverIdentityId: 'srv_write_error', accountId: 'account-a', currentAccount: true });
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://write-error.test',
            serverIdentityId: 'srv_write_error', accountId: 'account-a', machineId: 'm1',
            actionId: 'daemon.filesystem.writeFile', tokenEpoch: 0,
            execute: (input, context) => {
                expect(context.invocation).toMatchObject({ surface: 'ui', authority: 'present_user', caller: { kind: 'host' } });
                filesystem.requests.push({ payload: input });
                return filesystem.response;
            },
        });
        homes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
        homes.answer(serverId, 'GET /v1/machines/m1', { body: { machine: boundary.machine } });
        for (const path of ['/v1/actions/daemon.filesystem.writeFile/execution-authorization', '/v1/actions/daemon.filesystem.writeFile']) {
            homes.answer(serverId, path, { select: async (_input, request) => {
                const response = await boundary.handle(new URL(request.url), request.init);
                if (!response) throw new Error(`Unhandled write HTTP boundary: ${request.url}`);
                return { status: response.status, body: await response.json() };
            } });
        }
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
