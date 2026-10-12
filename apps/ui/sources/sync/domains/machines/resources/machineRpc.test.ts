import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// The authenticated machine connection is the network boundary; decoding and classification stay real.
const network = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(network.execute);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes); installDisconnectedServerSocketBoundary();
const { fetchMachineVitalsHistoryViaMachineRpc, fetchMachineVitalsViaMachineRpc, watchMachineVitalsViaMachineRpc } = await import('./machineRpc');

const key = { serverId: 'home', machineId: 'machine', view: 'summary' as const };
beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests(); network.execute.mockReset();
    key.serverId = await homes.addHome({ name: 'Vitals', serverUrl: 'https://vitals-read.test', accountId: 'owner', currentAccount: true });
});
afterEach(async () => { await homes.reset(); });

it('recognizes unavailable predecessor vitals operations on reads, history, and parked watches', async () => {
    for (const code of [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, RPC_ERROR_CODES.METHOD_NOT_FOUND]) {
        network.execute.mockRejectedValue(new RpcError('Unavailable operation', code));
        expect.soft(await fetchMachineVitalsViaMachineRpc(key)).toEqual({ ok: false, reason: 'older_happier' });
        expect.soft(await fetchMachineVitalsHistoryViaMachineRpc({ ...key, range: '1h' })).toEqual({ ok: false, reason: 'older_happier' });
        expect.soft(await watchMachineVitalsViaMachineRpc(key)).toEqual({ ok: false, reason: 'older_happier' });
    }
});

it('keeps denied access, transport failure, and invalid payloads distinct from older Happier', async () => {
    for (const error of [new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN), new Error('Socket not connected')]) {
        network.execute.mockRejectedValue(error);
        expect(await fetchMachineVitalsViaMachineRpc(key)).toEqual({ ok: false, reason: 'request_failed' });
    }
    network.execute.mockResolvedValue({ state: 'reporting' });
    expect(await fetchMachineVitalsViaMachineRpc(key)).toEqual({ ok: false, reason: 'invalid_response' });
});
