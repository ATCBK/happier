import { ClusterAdapter, MessageType, type ClusterMessage } from 'socket.io-adapter';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMachineSocketRoom, getUserMachinesSocketRoom } from '@/app/api/socketRooms';
import { getMachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { startRedisAdapterRecoveryCluster } from '@/testkit/redisAdapterRecoveryCluster';

import { buildRpcMethodRoom } from './rpcMethodRoom';
import { discoverRpcTargets } from './rpcTargetDiscovery';

const accountId = 'discovery-account';
const machineId = 'discovery-machine';
const method = `${machineId}:test`;

describe('target discovery with an unrelated slow Redis peer', () => {
    let cluster: Awaited<ReturnType<typeof startRedisAdapterRecoveryCluster>> | undefined;
    const clients: ClientSocket[] = [];

    afterEach(async () => {
        for (const client of clients.splice(0)) client.disconnect();
        vi.restoreAllMocks();
        await cluster?.close();
    });

    async function setup(targetNode: number | null, slowNode: number | null) {
        cluster = await startRedisAdapterRecoveryCluster({ nodeCount: 3 });
        let socketId: string | undefined;
        if (targetNode !== null) {
            const node = cluster.nodes[targetNode]!;
            const joined = new Promise<string>(resolve => node.io.once('connection', socket => {
                socket.data = { clientType: 'user-scoped' };
                socket.join(buildRpcMethodRoom({ userId: accountId, method }));
                socket.join(getUserMachinesSocketRoom(accountId));
                socket.join(getMachineSocketRoom(accountId, machineId));
                resolve(socket.id);
            }));
            const client = connect(`http://127.0.0.1:${node.port}`, {
                path: '/v1/updates', transports: ['websocket'], reconnection: false,
            });
            clients.push(client);
            socketId = await joined;
            client.on('rpc-probe', (value: unknown, acknowledge: (value: unknown) => void) => acknowledge(value));
        }
        if (slowNode !== null) {
            const adapter = cluster.nodes[slowNode]!.io.of('/').adapter;
            if (!(adapter instanceof ClusterAdapter)) throw new Error('Expected the real ClusterAdapter');
            // Instrument the external adapter's protected inbound transport hook only.
            const receiver = adapter as unknown as { onMessage(message: ClusterMessage, offset?: string): void };
            const onMessage = receiver.onMessage.bind(receiver);
            // Hold only inbound discovery traffic at the real adapter boundary;
            // the peer remains subscribed and counted by the other two nodes.
            vi.spyOn(receiver, 'onMessage').mockImplementation((message, offset) => {
                if (message.type === MessageType.FETCH_SOCKETS || message.type === MessageType.SERVER_SIDE_EMIT) return;
                onMessage(message, offset);
            });
        }
        return { io: cluster.nodes[0].io, socketId, targetNode };
    }

    for (const targetNode of [0, 1]) {
        it(`routes to a ${targetNode === 0 ? 'local' : 'remote'} target despite the unrelated slow peer`, async () => {
            const { io, socketId } = await setup(targetNode, 2);
            const result = await discoverRpcTargets({ io, userId: accountId, method, fetchTimeoutMs: 100 });
            expect(result?.targets.map(target => target.id)).toEqual([socketId]);
            expect(await result!.targets[0]!.timeout(1_000).emitWithAck('rpc-probe', { value: 'delivered' }))
                .toEqual({ value: 'delivered' });
        });

        it(`retains positive ${targetNode === 0 ? 'local' : 'remote'} Machine presence despite an incomplete census`, async () => {
            const { io, socketId } = await setup(targetNode, 2);
            cluster!.nodes[targetNode]!.io.sockets.sockets.get(socketId!)!.data = {
                userId: accountId, clientType: 'machine-scoped', machineId,
            };
            const presence = await getMachineDaemonPresenceInventory({ accountId, io });
            expect(presence.state).toBe('partial');
            expect(presence.state !== 'unavailable' && presence.machineIds.has(machineId)).toBe(true);
        });
    }

    it('proves absence only when all peers answer', async () => {
        const { io } = await setup(null, null);
        expect(await discoverRpcTargets({ io, userId: accountId, method, fetchTimeoutMs: 100 }))
            .toEqual({ targets: [], methodRoomEmpty: true });
        expect(await getMachineDaemonPresenceInventory({ accountId, io }))
            .toEqual({ state: 'known', machineIds: new Set() });
    });

    it('keeps an unanswered target unknown', async () => {
        const { io } = await setup(1, 1);
        expect(await discoverRpcTargets({ io, userId: accountId, method, fetchTimeoutMs: 100 })).toBeNull();
        expect(await getMachineDaemonPresenceInventory({ accountId, io })).toEqual({ state: 'unavailable' });
    });

    it('does not use a local candidate to claim global single-client uniqueness', async () => {
        const { io } = await setup(0, 2);
        expect(await discoverRpcTargets({ io, userId: accountId, method, fetchTimeoutMs: 100,
            answeringClient: { requireSingle: true } })).toBeNull();
    });

    it('retains exact-client selection and caller exclusion for streamed remote answers', async () => {
        const { io, socketId } = await setup(1, 2);
        expect(await discoverRpcTargets({ io, userId: accountId, method, fetchTimeoutMs: 100,
            excludedSocketId: socketId })).toBeNull();
        expect(await discoverRpcTargets({ io, userId: accountId, method, fetchTimeoutMs: 100,
            answeringClient: { clientId: 'not-connected' } })).toBeNull();
        expect((await discoverRpcTargets({ io, userId: accountId, method, fetchTimeoutMs: 100,
            answeringClient: { clientId: socketId!, requireSingle: true } }))?.targets.map(target => target.id))
            .toEqual([socketId]);
    });
});
