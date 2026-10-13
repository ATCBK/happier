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
const { machineRpcWithPeerMediationRoute } = await import('@/sync/domains/machines/peer/mediation/rpc/client');
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

it('preserves the direct handler failure as a typed uncertain outcome through the Vitals Action', async () => {
    const method = RPC_METHODS.MACHINES_VITALS_GET;
    const publicKey = Buffer.from(new Uint8Array(32).fill(1)).toString('base64url');
    const signature = Buffer.from(new Uint8Array(64).fill(2)).toString('base64url');
    const route = { kind: 'selected' as const, receipt: 'peer.route.selected' as const,
        endpoint: { url: 'http://127.0.0.1:3000', endpointFingerprint: 'endpoint_1' },
        grant: { payload: { v: 2 as const, grantId: 'grant_1', accountId: 'owner', machineId: key.machineId,
            flowKind: 'machine_rpc' as const, routeKind: 'loopback_direct' as const,
            scope: { kind: 'machine_rpc' as const, rpcScopeId: 'scope_1', allowedMethods: [method], maxCalls: 1, maxIdleMs: 10_000 },
            iat: 1_000, exp: 601_000, aud: 'happier-daemon-route-grant' as const, endpointFingerprint: 'endpoint_1',
            proofKind: 'ephemeral_ed25519' as const, ephemeralPublicKeyBase64Url: publicKey },
            signature: { keyId: 'key_1', alg: 'Ed25519' as const, valueBase64Url: signature } },
        proof: { v: 2 as const, kind: 'ephemeral_ed25519' as const, signedGrantDigestBase64Url: publicKey,
            nonceBase64Url: Buffer.from(new Uint8Array(16).fill(3)).toString('base64url'), signatureBase64Url: signature } };
    const serverFallback = vi.fn(async () => ({}));
    // The existing machine-connection boundary now exercises the real direct route beneath it.
    // Endpoint discovery and the daemon HTTP response are the only replaced external boundaries.
    network.execute.mockImplementation((request: { machineId: string; method: string; payload: unknown }) =>
        machineRpcWithPeerMediationRoute({ ...request, serverId: key.serverId, accountId: 'owner',
            resolveDirectRoute: async () => route,
            createRequestId: () => 'request_1',
            postDirect: async () => ({ v: 2 as const, ok: false as const,
                receipt: 'peer.rpc.fell_back_to_server' as const, requestId: 'request_1', method,
                reasonCode: 'handler_unavailable' as const }), serverFallback }));
    expect(await fetchMachineVitalsViaMachineRpc(key))
        .toEqual({ ok: false, reason: 'request_failed', errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
    expect(serverFallback).not.toHaveBeenCalled();
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
