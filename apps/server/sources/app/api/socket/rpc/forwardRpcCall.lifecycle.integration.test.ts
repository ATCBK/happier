import { once } from 'node:events';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { Socket } from 'socket.io';
import { MessageType } from 'socket.io-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { startRedisAdapterRecoveryCluster } from '@/testkit/redisAdapterRecoveryCluster';

// Persistence and metrics are external boundaries; discovery, selection,
// Socket.IO and both Redis adapter nodes remain real.
vi.mock('@/storage/db', () => ({ db: { machine: { findFirst: vi.fn() } } }));
vi.mock('@/app/monitoring/metrics/index', () => ({
    observeRpcCall: vi.fn(), observeRpcTargetLookup: vi.fn(), recordRpcCallFailure: vi.fn(),
    recordRpcMethodNotAvailable: vi.fn(), recordRpcSelfCallRejection: vi.fn(), recordSocketClusterFetchSockets: vi.fn(),
}));

import { forwardRpcCall } from './forwardRpcCall';
import { buildRpcMethodRoom } from './rpcMethodRoom';

function receiveRpcRequest(target: ClientSocket): Promise<readonly [unknown, (result: unknown) => void]> {
    return new Promise(resolve => {
        target.once(SOCKET_RPC_EVENTS.REQUEST, (payload: unknown, acknowledge: (result: unknown) => void) => {
            resolve([payload, acknowledge]);
        });
    });
}

describe('forwarded RPC ACK lifetime across Redis adapter nodes', () => {
    let cluster: Awaited<ReturnType<typeof startRedisAdapterRecoveryCluster>>;
    const clients: ClientSocket[] = [];
    let timers: ReturnType<typeof setTimeout>[];
    let cleared: Set<ReturnType<typeof setTimeout>>;

    beforeAll(async () => { cluster = await startRedisAdapterRecoveryCluster(); });
    afterAll(async () => { await cluster?.close(); });
    afterEach(() => {
        for (const client of clients.splice(0)) client.disconnect();
        vi.restoreAllMocks();
        // Also close the original upstream timers on a deliberate RED run.
        for (const timer of timers ?? []) clearTimeout(timer);
        for (const node of cluster?.nodes ?? []) {
            (node.io.of('/').adapter as unknown as { ackRequests: Map<string, unknown> }).ackRequests.clear();
        }
    });

    async function fixture(destinationIndex: 0 | 1 = 1) {
        const source = cluster.nodes[0];
        const destination = cluster.nodes[destinationIndex];
        const accepted = once(destination.io, 'connection');
        const target = connect(`http://127.0.0.1:${destination.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
        });
        clients.push(target);
        await new Promise<void>(resolve => target.once('connect', resolve));
        const [targetSocket] = await accepted as [Socket];
        const method = `session-${target.id}:execution.run.start`;
        await targetSocket.join(buildRpcMethodRoom({ userId: 'account-one', method }));
        timers = [];
        cleared = new Set();
        const nativeSetTimeout = globalThis.setTimeout;
        const nativeClearTimeout = globalThis.clearTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
            const timer = nativeSetTimeout(callback, delay, ...args);
            if (delay === 2_147_483_647) timers.push(timer);
            return timer;
        });
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation(timer => {
            if (timer && typeof timer !== 'string' && typeof timer !== 'number') cleared.add(timer);
            nativeClearTimeout(timer);
        });
        const pendingTargetAcks = () => (targetSocket as unknown as { acks: Map<number, unknown> }).acks.size;
        const pendingSourceAcks = () => (source.io.of('/').adapter as unknown as { ackRequests: Map<string, unknown> }).ackRequests.size;
        const assertDisposed = async () => {
            await vi.waitFor(() => {
                expect(pendingTargetAcks()).toBe(0);
                expect(pendingSourceAcks()).toBe(0);
                expect(timers.length).toBeGreaterThan(0);
                expect(timers.every(timer => cleared.has(timer))).toBe(true);
            });
        };
        return { source, target, targetSocket, method, assertDisposed };
    }

    it.each([0, 1] as const)('settles exact target loss on node %s once as unknown and disposes original ACK resources', async destinationIndex => {
        const { source, target, targetSocket, method, assertDisposed } = await fixture(destinationIndex);
        const submittedUnknown = vi.fn();
        const requests = vi.fn();
        target.on(SOCKET_RPC_EVENTS.REQUEST, requests);
        const received = receiveRpcRequest(target);
        let result: unknown;
        const response = forwardRpcCall({ io: source.io, targetUserId: 'account-one', method,
            callParams: {}, timeoutMs: null, onSubmittedUnknown: submittedUnknown });
        void response.then(value => { result = value; });
        await received;
        const disconnected = once(targetSocket, 'disconnect');
        target.disconnect();
        await disconnected;
        await vi.waitFor(() => expect(result).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN }));
        await assertDisposed();
        expect(submittedUnknown).toHaveBeenCalledOnce();
        expect(requests).toHaveBeenCalledOnce();
    });

    it.each([0, 1] as const)('settles a cancelled null-timeout caller on node %s as unknown and retires ACK custody', async destinationIndex => {
        const { source, target, method, assertDisposed } = await fixture(destinationIndex);
        const received = receiveRpcRequest(target);
        const controller = new AbortController();
        const submittedUnknown = vi.fn();
        const requests = vi.fn();
        target.on(SOCKET_RPC_EVENTS.REQUEST, requests);
        let result: unknown;
        const response = forwardRpcCall({ io: source.io, targetUserId: 'account-one', method,
            callParams: {}, timeoutMs: null, onSubmittedUnknown: submittedUnknown,
            cancellation: { targetRequestId: 'ack-lifetime-authenticated-cancellation', signal: controller.signal, onTargetSelected: () => {} },
        });
        void response.then(value => { result = value; });
        const [, acknowledge] = await received;
        controller.abort();
        await vi.waitFor(() => expect(result).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN }));
        await assertDisposed();
        acknowledge({ authenticatedCancellation: true });
        target.disconnect();
        await expect(response).resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
        expect(submittedUnknown).toHaveBeenCalledOnce();
        expect(requests).toHaveBeenCalledOnce();
    });

    it.each([0, 1] as const)('retires source and target ACK custody on node %s when the finite caller wait is cancelled', async destinationIndex => {
        const { source, target, method, assertDisposed } = await fixture(destinationIndex);
        // Observe the decoded external Redis carrier: request and retirement
        // must share PUB/SUB ordering, rather than cross the Streams backplane.
        const adapter = cluster.nodes[destinationIndex].io.of('/').adapter as unknown as {
            onMessage(message: { type: number; data?: { requestId?: string; opts?: { rooms?: string[] } } }, offset?: string): void;
        };
        const incoming = vi.spyOn(adapter, 'onMessage');
        const received = receiveRpcRequest(target);
        const controller = new AbortController();
        const response = forwardRpcCall({ io: source.io, targetUserId: 'account-one', method,
            callParams: {}, timeoutMs: 2_147_483_647,
            cancellation: { targetRequestId: 'ack-lifetime-finite-cancellation', signal: controller.signal, onTargetSelected: () => {} },
        });
        const [, acknowledge] = await received;
        controller.abort();
        await expect(response).resolves.toMatchObject({ ok: false });
        await assertDisposed();
        if (destinationIndex === 1) {
            const controls = incoming.mock.calls
                .filter(([message]) => message.data?.requestId && message.data.opts?.rooms?.includes(target.id ?? ''))
                .map(([message, offset]) => ({ type: message.type, ephemeral: offset === undefined }));
            expect(controls).toEqual([
                { type: MessageType.BROADCAST, ephemeral: true },
                { type: MessageType.BROADCAST_ACK, ephemeral: true },
            ]);
        }
        acknowledge({ admitted: true });
        expect(target.connected).toBe(true);
    });

    it('does not send departure ACKs for an origin that did not opt in', async () => {
        const { source, target, method } = await fixture();
        const [remote] = await source.io.in(buildRpcMethodRoom({ userId: 'account-one', method })).fetchSockets();
        const received = receiveRpcRequest(target);
        const response = remote.timeout(100).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, { method });
        const rejected = expect(response).rejects.toThrow('operation has timed out');
        await received;
        target.disconnect();
        await rejected;
    });
});
