import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createMachineStorageStore } from '@/sync/domains/machines/storage/machineStorageStore';
import { fetchMachineStorageSummaryViaAction, moveMachineStorageToTrashViaAction } from '@/sync/domains/machines/storage/machineRpc';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Daemon transport and its deadline are the system boundary; Actions, schemas,
// scope capture, the Storage adapters and receipt store remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); rpc.machine.mockReset(); });
afterEach(async () => { vi.useRealTimers(); await homes.reset(); });

describe('Storage receipt through the captured UI Action Home', () => {
    it('keeps retired reads closed rather than disclosing their Account content', async () => {
        const serverId = await homes.addHome({ name: 'Storage Home', serverUrl: 'https://storage-read.test', accountId: 'owner', currentAccount: true });
        const controller = new AbortController();
        rpc.machine.mockImplementationOnce(async () => {
            controller.abort();
            return { revision: 1, sizedAt: 1, volumes: [], categories: [], suggestionsTop: [],
                pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } };
        });
        expect(await fetchMachineStorageSummaryViaAction({ serverId, expectedAccountId: 'owner', machineId: 'machine', signal: controller.signal }))
            .toEqual({ ok: false, reason: 'request_failed' });
    });
    it('retains a consumed cleanup acknowledgement when its caller retires afterward', async () => {
        const serverId = await homes.addHome({ name: 'Storage Home', serverUrl: 'https://storage-ack.test', accountId: 'owner', currentAccount: true });
        const controller = new AbortController();
        const receipt = { batchId: 'batch', mode: 'trash', outcomes: [{ itemId: 'cache', status: 'moved' }], inTrashBytes: 4096, freedBytes: 0 };
        rpc.machine.mockImplementationOnce(async () => { controller.abort(); return receipt; });
        const ref = { itemId: 'cache', path: '/cache', identity: { dev: '1', ino: '2', kind: 'directory' as const },
            collectedAt: 1, collectedBy: { accountId: 'owner', kind: 'person' as const } };
        expect(await moveMachineStorageToTrashViaAction({ serverId, expectedAccountId: 'owner', machineId: 'machine',
            signal: controller.signal, items: [{ ref, expect: 'checked', claimedVerdict: 'safe' }] }))
            .toEqual({ ok: true, value: receipt });
    });
    it('waits for the accepted cleanup beyond the read deadline, retains the batch and restores it with Undo', async () => {
        const serverId = await homes.addHome({ name: 'Storage Home', serverUrl: 'https://storage-receipt.test', accountId: 'owner', currentAccount: true });
        const key = { serverId, expectedAccountId: 'owner', machineId: 'machine' };
        const receipt = { batchId: 'batch', mode: 'trash', outcomes: [{ itemId: 'cache', status: 'moved' }], inTrashBytes: 4096, freedBytes: 0 };
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        rpc.machine.mockImplementationOnce((request: { operationTimeoutMs?: null }) => {
            entered();
            return new Promise((resolve, reject) => {
                const deadline = request.operationTimeoutMs === null ? null : setTimeout(() => reject(new Error('MACHINE_RPC_TIMEOUT')), DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
                setTimeout(() => { if (deadline) clearTimeout(deadline); resolve(receipt); }, DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1000);
            });
        });
        const summary = { revision: 1, sizedAt: 1, volumes: [], categories: [], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } };
        const store = createMachineStorageStore({ summaryClient: async () => ({ ok: true, value: summary }),
            categoryClient: async () => ({ ok: false, reason: 'request_failed' }), refreshClient: async () => ({ ok: true, value: summary }),
            watchClient: async () => ({ ok: true, value: { changed: false } }) });
        const ref = { itemId: 'cache', path: '/cache', identity: { dev: '1', ino: '2', kind: 'directory' as const },
            collectedAt: 1, collectedBy: { accountId: 'owner', kind: 'person' as const } };
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const applied = store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'reviewed', claimedVerdict: 'safe' }] });
            await started;
            await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1000);
            expect(await applied).toEqual({ ok: true, value: receipt });
            expect(store.getReceipt(key)).toMatchObject({ kind: 'applied', result: receipt });
            rpc.machine.mockImplementationOnce(async (request: { method: string; payload: { batchId?: string } }) => {
                if (request.method !== RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE || request.payload.batchId !== receipt.batchId) throw new Error('Wrong batch');
                return { outcomes: [{ entryId: 'entry', status: 'restored', path: ref.path }] };
            });
            expect(await store.undoReceipt(key)).toEqual({ ok: true, value: { outcomes: [{ entryId: 'entry', status: 'restored', path: ref.path }] } });
            expect(store.getReceipt(key)).toBeNull();
        } finally { store.reset(); }
    });
});
