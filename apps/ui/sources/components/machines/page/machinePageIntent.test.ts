import { describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ execute: vi.fn() }));
// The Action front door is the boundary; the storage store and the intent routing run for real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => boundary.execute }));
// The Machine network transport, as in the storage store suite.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: vi.fn() }));

// Load the mocked front door once up front, as the storage store suite does (its adapter imports it lazily).
await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
await import('@/sync/domains/machines/storage/machineRpc');
const { beginMachinePageTabIntent } = await import('./machinePageIntent');

async function settle() { for (let turn = 0; turn < 64; turn++) await new Promise(resolve => setTimeout(resolve, 0)); }

describe('opening a machine page from an attention entry', () => {
    it('prepares the low-disk pile at the person’s tap, for that machine and disk only', async () => {
        boundary.execute.mockImplementation(async (action: string) => ({ ok: true, result: action === 'machines.storage.suggestions.list'
            ? { revision: 1, items: [] } : { revision: 1, items: [], summary: { count: 0, freesBytes: 0, droppedSinceLastView: [] } } }));
        beginMachinePageTabIntent({ serverId: 'home', machineId: 'm' }, { id: 'storage', prepare: 'lowDisk', volumeId: 'data' });
        const lists = () => boundary.execute.mock.calls.filter(([action]) => action === 'machines.storage.suggestions.list');
        await vi.waitFor(() => expect(lists()).toHaveLength(1));
        expect(lists()[0]![1]).toMatchObject({ machineId: 'm', serverId: 'home', quickestForVolume: 'data' });
        boundary.execute.mockClear();
        beginMachinePageTabIntent({ serverId: 'home', machineId: 'm' }, { id: 'storage' });
        beginMachinePageTabIntent({ serverId: 'home', machineId: 'm' }, { id: 'processes', sort: 'memory' });
        beginMachinePageTabIntent({ serverId: 'home', machineId: 'm' }, null);
        await settle();
        expect(boundary.execute).not.toHaveBeenCalled();
    });
});
