import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachineVitalsGetInputV1Schema, MachineVitalsSnapshotV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
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
    network.execute.mockRejectedValue(new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN));
    expect(await fetchMachineVitalsViaMachineRpc(key)).toEqual({ ok: false, reason: 'request_failed', errorCode: RPC_ERROR_CODES.FORBIDDEN });
    network.execute.mockRejectedValue(new Error('Socket not connected'));
    expect(await fetchMachineVitalsViaMachineRpc(key)).toEqual({ ok: false, reason: 'request_failed', errorCode: 'action_failed' });
    network.execute.mockResolvedValue({ state: 'reporting' });
    expect(await fetchMachineVitalsViaMachineRpc(key)).toEqual({ ok: false, reason: 'invalid_response', errorCode: 'invalid_action_output' });
});

it('reads a reporting machine through the real Action wiring with its exact Home and machine', async () => {
    const snapshot = MachineVitalsSnapshotV1Schema.parse({ state: 'reporting', sample: {
        v: 1, sampledAt: Date.now(), intervalMs: 15_000,
        cpu: { reported: true, busyPct: 20 },
        memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
        disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 },
    }, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
    network.execute.mockResolvedValue(snapshot);
    expect(await fetchMachineVitalsViaMachineRpc(key)).toEqual({ ok: true, value: snapshot });
    const request = network.execute.mock.calls.find(([request]) => request.method === RPC_METHODS.MACHINES_VITALS_GET)?.[0];
    expect(request).toMatchObject({ serverId: key.serverId, accountId: 'owner', machineId: key.machineId });
    expect(MachineVitalsGetInputV1Schema.parse(request.payload)).toEqual({ serverId: key.serverId, machineId: key.machineId, view: 'summary' });
});

it('keeps the Action admission refusal code before any machine request leaves the client', async () => {
    homes.answer(key.serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: { 'machines.vitals.get': { enabled: false } } },
    } }, version: 1 } });
    expect(await fetchMachineVitalsViaMachineRpc(key))
        .toMatchObject({ ok: false, reason: 'request_failed', errorCode: 'action_disabled' });
    expect(network.execute).not.toHaveBeenCalled();
});
