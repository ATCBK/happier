import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachineStoragePileSetInputV1Schema, MachineStoragePileResultV1Schema, StorageItemV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only the network is replaced; the tap intent, storage store, Action policy and captured scope stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
// Prepare the real lazy Action module during collection; intent completion is measured after module loading.
await import('@/sync/ops/actions/defaultActionExecutor');
const { beginMachinePageTabIntent } = await import('./machinePageIntent');
const { machineStorageStore } = await import('@/sync/domains/machines/storage/machineStorageStore');
afterEach(async () => { machineStorageStore.reset(); boundary.rpc.mockReset(); await homes.reset(); });

describe('opening a machine page from an attention entry', () => {
    it('prepares the low-disk pile at the person’s tap, for that machine and disk only', async () => {
        const serverId = await homes.addHome({ name: 'Page intent', serverUrl: 'https://machine-intent.test',
            serverIdentityId: 'srv_machine_intent', accountId: 'owner', currentAccount: true });
        const target = { serverId, machineId: 'm' };
        const safe = StorageItemV1Schema.parse({ itemId: 'cache', kind: 'suggestion', title: 'Cache', path: '/data/cache',
            evidence: [], verdict: 'safe', reason: { code: 'rebuilds' }, collectable: true,
            size: { allocatedBytes: 64, freesBytes: 64, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false } });
        const emptyPile = MachineStoragePileResultV1Schema.parse({ revision: 1, items: [],
            summary: { count: 0, freesBytes: 0, droppedSinceLastView: [] } });
        boundary.rpc.mockImplementation(async ({ method, payload, accountId }: { method: string; payload: unknown; accountId?: string }) => {
            expect(accountId).toBe('owner');
            if (method === RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_LIST) {
                expect(payload).toEqual({ machineId: 'm', serverId: 'srv_machine_intent', quickestForVolume: 'data' });
                return { revision: 1, items: [safe, { ...safe, itemId: 'caution', path: '/data/caution', verdict: 'caution' }] };
            }
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_GET) return emptyPile;
            if (method === RPC_METHODS.DAEMON_STORAGE_PILE_SET) {
                expect(MachineStoragePileSetInputV1Schema.parse(payload).add).toEqual([{ itemId: safe.itemId, path: safe.path }]);
                return MachineStoragePileResultV1Schema.parse({ revision: 2, items: [{ itemId: safe.itemId, path: safe.path,
                    identity: { dev: '1', ino: '2', kind: 'directory' }, collectedAt: 100,
                    collectedBy: { accountId: 'owner', kind: 'person' } }],
                    summary: { count: 1, freesBytes: 64, droppedSinceLastView: [] } });
            }
            throw new Error(`Unexpected machine intent RPC: ${method}`);
        });
        beginMachinePageTabIntent(target, { id: 'storage', prepare: 'lowDisk', volumeId: 'data' });
        await vi.waitFor(() => expect(machineStorageStore.getPile(target)).toMatchObject({
            pending: false, page: { revision: 2, items: [{ itemId: safe.itemId, path: safe.path }], summary: { count: 1, freesBytes: 64 } },
        }));
        expect(machineStorageStore.getPile({ ...target, machineId: 'another-machine' }).page).toBeNull();
        boundary.rpc.mockClear();
        beginMachinePageTabIntent(target, { id: 'storage' });
        beginMachinePageTabIntent(target, { id: 'processes', sort: 'memory' });
        beginMachinePageTabIntent(target, null);
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
});
