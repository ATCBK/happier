import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';

// Only the Action front door and authenticated Machine RPC network transport are replaced.
const boundary = vi.hoisted(() => ({ execute: vi.fn(), rpc: vi.fn() }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => boundary.execute }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));
import { fetchMachineStorageSummaryViaAction, fetchMachineStorageCategoryViaAction, refreshMachineStorageSizeViaAction, watchMachineStorageViaMachineRpc } from './machineRpc';
import * as storageRpc from './machineRpc';

const key = { serverId: 'home-a', machineId: 'machine-a', expectedAccountId: 'account-a' };
describe('storage Action and Machine RPC boundary', () => {
    it('fails unavailable scan and protection operations closed without a direct RPC fallback', async () => {
        boundary.execute.mockResolvedValue({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' });
        expect(await storageRpc.fetchMachineStorageScanViaAction({ ...key, view: { tab: 'old', depth: 1, olderThanDays: 1000 } }))
            .toEqual({ ok: false, reason: 'older_happier' });
        expect(await storageRpc.startMachineStorageScanViaAction({ ...key, target: { folderPath: '/folder' } }))
            .toEqual({ ok: false, reason: 'older_happier' });
        expect(await storageRpc.addMachineStorageProtectedFolderViaAction({ ...key, path: '/folder' }))
            .toEqual({ ok: false, reason: 'older_happier' });
        expect(boundary.execute.mock.calls.map(([id]) => id)).toEqual(['machines.storage.scan.get', 'machines.storage.scan.start', 'machines.storage.protected.add']);
        expect(boundary.execute.mock.calls[0][1]).toEqual({ machineId: key.machineId, serverId: key.serverId, view: { tab: 'old', depth: 1, olderThanDays: 1000 } });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
    afterEach(() => { boundary.execute.mockReset(); boundary.rpc.mockReset(); });

    it('degrades a predecessor missing operation through the Action front door without issuing a fallback RPC', async () => {
        boundary.execute.mockResolvedValue({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' });
        expect(await fetchMachineStorageSummaryViaAction(key)).toEqual({ ok: false, reason: 'older_happier' });
        expect(await fetchMachineStorageCategoryViaAction({ ...key, categoryId: 'logs', cursor: 'daemon-cursor' })).toEqual({ ok: false, reason: 'older_happier' });
        expect(await refreshMachineStorageSizeViaAction({ ...key, categoryId: 'logs' })).toEqual({ ok: false, reason: 'older_happier' });
        expect(boundary.execute.mock.calls.map(([action]) => action)).toEqual(['machines.storage.summary.get', 'machines.storage.category.list', 'machines.storage.size.refresh']);
        expect(boundary.execute.mock.calls[1][1]).toEqual({ serverId: 'home-a', machineId: 'machine-a', categoryId: 'logs', cursor: 'daemon-cursor' });
        expect(boundary.execute.mock.calls[0][2]).toMatchObject({ surface: 'ui', serverId: 'home-a', expectedAccountId: 'account-a' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('parks on canonical Machine RPC with its owning watch window and rejects malformed replies', async () => {
        const controller = new AbortController();
        boundary.rpc.mockResolvedValueOnce({ changed: false });
        expect(await watchMachineStorageViaMachineRpc({ ...key, sinceRevision: 3, signal: controller.signal })).toEqual({ ok: true, value: { changed: false } });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({
            serverId: 'home-a', accountId: 'account-a', machineId: 'machine-a', method: RPC_METHODS.DAEMON_STORAGE_WATCH,
            payload: { serverId: 'home-a', machineId: 'machine-a', sinceRevision: 3 }, signal: controller.signal,
            timeoutMs: MACHINE_WATCH_WINDOW_MS + 10_000,
        }));
        boundary.rpc.mockResolvedValueOnce({ changed: true });
        expect(await watchMachineStorageViaMachineRpc(key)).toEqual({ ok: false, reason: 'invalid_response' });
        boundary.rpc.mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND));
        expect(await watchMachineStorageViaMachineRpc(key)).toEqual({ ok: false, reason: 'older_happier' });
        controller.abort();
        expect(await watchMachineStorageViaMachineRpc({ ...key, signal: controller.signal })).toEqual({ ok: false, reason: 'request_failed' });
    });

    it('uses the scoped Action front door for pile deltas and retains only daemon-validated results', async () => {
        const value = { revision: 2, items: [], summary: { count: 0, freesBytes: 0, droppedSinceLastView: [] } };
        boundary.execute.mockResolvedValueOnce({ ok: true, result: value });
        expect(await storageRpc.setMachineStoragePileViaAction({ ...key, clear: true })).toEqual({ ok: true, value });
        expect(boundary.execute).toHaveBeenLastCalledWith('machines.storage.pile.set',
            { machineId: key.machineId, serverId: key.serverId, clear: true },
            expect.objectContaining({ surface: 'ui', expectedAccountId: key.expectedAccountId }));
        boundary.execute.mockResolvedValueOnce({ ok: true, result: { ...value, items: [{ path: '/unproven' }] } });
        expect(await storageRpc.setMachineStoragePileViaAction({ ...key, clear: true })).toEqual({ ok: false, reason: 'invalid_response' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
});
