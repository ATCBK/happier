import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema,
    type DirectRouteGrantRequestV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { PeerLoopbackEndpointCandidateV1Schema } from '@happier-dev/protocol/machines/peer/mediation/loopbackEndpointV1';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { PEER_MACHINE_RPC_DIRECT_PATH_V2, PeerMachineRpcDirectRequestV2Schema,
    PeerMachineRpcDirectResponseV2Schema, type PeerMachineRpcDirectRequestV2 } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// Home admission, the applied Account lifetime, route policy/proofs and the RPC
// client remain real. Only Home HTTP/Socket.IO and daemon HTTP are replaced.
const boundary = await installSessionOpsNetworkBoundary();
const { machineRpcWithServerScope, createOrderedMachineRpcCaller } = await import('./serverScopedMachineRpc');
const { resetScopedMachineTransportCacheForTests } = await import('./serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { clearMachineRpcPeerMediationReceiptsForTest, getMachineRpcPeerMediationReceiptsSnapshot } = await import('@/sync/domains/machines/peer/mediation/rpc/receiptLog');
const { getStorage } = await import('@/sync/domains/state/storageStore');

const grantRequests: DirectRouteGrantRequestV2[] = [];
const directRequests: PeerMachineRpcDirectRequestV2[] = [];
const directSignals: Array<AbortSignal | null | undefined> = [];
const directResponses: Promise<Response>[] = [];
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let prepareGrant = async (_request: DirectRouteGrantRequestV2): Promise<void> => {};
let directReply = async (request: PeerMachineRpcDirectRequestV2): Promise<unknown> => request.params;

afterAll(() => boundary.dispose());

describe('machineRpcWithServerScope signal (direct peer route)', () => {
    beforeEach(async () => {
        boundary.resetRequests();
        resetScopedMachineTransportCacheForTests();
        resetServerFeaturesClientForTests();
        clearMachineRequestReachabilityForTest();
        clearMachineRpcPeerMediationReceiptsForTest();
        grantRequests.length = 0;
        directRequests.length = 0;
        directSignals.length = 0;
        directResponses.length = 0;
        prepareGrant = async () => {};
        directReply = async (request) => request.params;
        const home = await boundary.addHome('https://server-a.example.test', 'account_1');
        const endpoint = PeerLoopbackEndpointCandidateV1Schema.parse({
            v: 1, routeKind: 'loopback_direct', url: 'http://127.0.0.1:3000',
            endpointFingerprint: 'endpoint_1', expiresAt: Date.now() + 300_000,
        });
        const machineRow = {
            ...createPlainMachineRowFixture({ id: 'machine_1', accountId: home.accountId }),
            daemonState: encodePlainMachineStoredContent(MachinePublishedDaemonStateV1Schema.parse({
                status: 'running', peerMediation: { loopback: { endpoint } },
            })),
        };
        boundary.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/machines') return Response.json([machineRow]);
            if (path === '/v1/machines/machine_1') return Response.json({ machine: machineRow });
            if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
                features: { machines: { enabled: true, rpc: { enabled: true, directPeer: { enabled: true } } } },
                capabilities: {},
            }));
            if (path !== '/v1/machines/peer/mediation/route-grants') return null;
            // Consume the real client's request and mint the boundary response
            // from that exact ephemeral key, scope and endpoint binding.
            const request = DirectRouteGrantRequestV2Schema.parse(JSON.parse(String(init?.body)));
            grantRequests.push(request);
            await prepareGrant(request);
            const now = Date.now();
            return Response.json({ ok: true, grant: SignedDirectRouteGrantV2Schema.parse({
                payload: {
                    v: 2, grantId: `grant_${grantRequests.length}`, accountId: home.accountId,
                    machineId: request.machineId, flowKind: request.flowKind, routeKind: request.routeKind,
                    scope: request.scope, iat: now, exp: now + request.ttlMs, aud: 'happier-daemon-route-grant',
                    endpointFingerprint: request.endpointFingerprint, proofKind: 'ephemeral_ed25519',
                    ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url,
                },
                signature: { keyId: 'key_1', alg: 'Ed25519',
                    valueBase64Url: Buffer.from(new Uint8Array(64).fill(2)).toString('base64url') },
            }) });
        });
        vi.stubGlobal('fetch', vi.fn<typeof fetch>((input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe(endpoint.url);
            expect(url.pathname).toBe(PEER_MACHINE_RPC_DIRECT_PATH_V2);
            if (init?.method === 'OPTIONS') return Promise.resolve(new Response(null, { status: 204 }));
            expect(init?.method).toBe('POST');
            const request = PeerMachineRpcDirectRequestV2Schema.parse(JSON.parse(String(init?.body)));
            directRequests.push(request);
            directSignals.push(init?.signal);
            const response = directReply(request).then(result => Response.json(PeerMachineRpcDirectResponseV2Schema.parse({
                v: 2, ok: true, requestId: request.requestId, method: request.method,
                receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded, routeKind: 'loopback_direct', result,
            })));
            directResponses.push(response);
            return response;
        }));
        account = await restoreServerAccountForTest({
            serverUrl: home.serverUrl, accountId: home.accountId, request: boundary.request,
        });
        // Bootstrap and later refreshes must hydrate the same advertised
        // topology through the real stored-content reader.
        const { sync } = await import('@/sync/sync');
        await sync.refreshMachines();
        expect(getStorage().getState().machines.machine_1?.daemonState?.peerMediation?.loopback?.endpoint).toEqual(endpoint);
    });

    afterEach(async () => {
        await account?.dispose();
        account = undefined;
        await serverScopedRpcSocketPool.stopAll();
        await resetServerReachabilitySupervisors();
        vi.unstubAllGlobals();
    });

    it('orders delayed route preparation while keeping recognition replies concurrently in flight', async () => {
        const routeReady = createDeferred<void>();
        prepareGrant = async () => { await routeReady.promise; };
        const replies = [createDeferred<unknown>(), createDeferred<unknown>()];
        directReply = async (request) => {
            const { seq } = request.params as { seq: number };
            return await replies[seq]!.promise;
        };
        const call = createOrderedMachineRpcCaller();
        const first = call({ machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS, payload: { seq: 0 } });
        const second = call({ machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS, payload: { seq: 1 } });
        const settled = Promise.allSettled([first, second]);
        try {
            await vi.waitFor(() => expect(grantRequests).toHaveLength(1));
            expect(directRequests).toEqual([]);
            routeReady.resolve();
            await vi.waitFor(() => expect(directRequests.map(request => request.params)).toEqual([{ seq: 0 }, { seq: 1 }]));
            // A reply fence would leave only seq 0 dispatched at this point.
            replies[1]!.resolve({ ackSeq: 1 });
            replies[0]!.resolve({ ackSeq: 0 });
            await expect(second).resolves.toEqual({ ackSeq: 1 });
            await expect(first).resolves.toEqual({ ackSeq: 0 });
            expect(boundary.requests).toEqual([]);
        } finally {
            routeReady.resolve();
            replies.forEach(reply => reply.resolve(null));
            await settled;
        }
    });

    it('cancels a queued preparation promptly without opening its predecessor dispatch fence', async () => {
        const routeReady = createDeferred<void>();
        prepareGrant = async () => { await routeReady.promise; };
        directReply = async (request) => (request.params as { seq: number }).seq;
        const call = createOrderedMachineRpcCaller();
        const params = { machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS };
        const first = call({ ...params, payload: { seq: 0 } });
        const abort = new AbortController();
        const cancelled = call({ ...params, payload: { seq: 1 }, signal: abort.signal });
        const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        const third = call({ ...params, payload: { seq: 2 } });
        const settled = Promise.allSettled([first, cancelled, third]);
        try {
            await vi.waitFor(() => expect(grantRequests).toHaveLength(1));
            abort.abort();
            await rejected;
            expect(directRequests).toEqual([]);
            expect(grantRequests).toHaveLength(1);
            routeReady.resolve();
            await expect(first).resolves.toBe(0);
            await expect(third).resolves.toBe(2);
            expect(directRequests.map(request => request.params)).toEqual([{ seq: 0 }, { seq: 2 }]);
            expect(boundary.requests).toEqual([]);
        } finally {
            routeReady.resolve();
            await settled;
        }
    });

    it('rejects promptly during peer-route discovery and does not dispatch after it later resolves', async () => {
        const routeReady = createDeferred<void>();
        prepareGrant = async () => { await routeReady.promise; };
        const controller = new AbortController();
        const pending = machineRpcWithServerScope({
            machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true }, signal: controller.signal,
        });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        try {
            await vi.waitFor(() => expect(grantRequests).toHaveLength(1));
            controller.abort();
            await rejected;
            routeReady.resolve();
            // Observe the real route consumer after the delayed HTTP grant.
            await vi.waitFor(() => expect(getMachineRpcPeerMediationReceiptsSnapshot()).toContainEqual(
                expect.objectContaining({ receipt: PEER_MEDIATION_RECEIPTS.routeSelected }),
            ));
            expect(directRequests).toEqual([]);
            expect(boundary.requests).toEqual([]);
        } finally {
            routeReady.resolve();
            await Promise.allSettled([pending]);
        }
    });

    it('rejects with an abort error when the signal fires during an in-flight direct call', async () => {
        const reply = createDeferred<unknown>();
        directReply = async () => await reply.promise;
        const controller = new AbortController();
        const pending = machineRpcWithServerScope({
            machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true }, signal: controller.signal,
        });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        try {
            await vi.waitFor(() => expect(directRequests).toHaveLength(1));
            controller.abort();
            await rejected;
            expect(directSignals[0]?.aborted).toBe(true);
            expect(boundary.requests).toEqual([]);
        } finally {
            reply.resolve(null);
            await Promise.allSettled([pending, ...directResponses]);
        }
    });

    it('rejects immediately without dispatching the direct request when already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(machineRpcWithServerScope({
            machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true }, signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        expect(grantRequests).toEqual([]);
        expect(directRequests).toEqual([]);
        expect(boundary.requests).toEqual([]);
    });
});
