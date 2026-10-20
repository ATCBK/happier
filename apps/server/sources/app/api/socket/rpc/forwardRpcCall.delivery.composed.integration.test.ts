import { once } from 'node:events';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { Socket } from 'socket.io';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { callSocketRpc } from '@happier-dev/sync-client';
import { startRedisAdapterRecoveryCluster } from '@/testkit/redisAdapterRecoveryCluster';
import { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '../../../../../../cli/src/api/encryption';
import { isMachineDaemonRpcUnsupportedError } from '../../../../../../ui/sources/sync/domains/machines/machineDaemonRpcErrors';
import { db } from '@/storage/db';
import { getMachineSocketRoom } from '../../socketRooms';
import { registerSocketRpcHandlers } from './registerSocketRpcHandlers';

// Only persistence and metrics are external boundaries. The shared UI client,
// Home relay, Redis adapters and daemon handler manager all run their real logic.
vi.mock('@/storage/db', () => ({ db: { machine: { findFirst: vi.fn() } } }));
vi.mock('@/app/monitoring/metrics/index', () => ({
    observeRpcCall: vi.fn(), observeRpcTargetLookup: vi.fn(), recordRpcCallFailure: vi.fn(),
    recordRpcMethodNotAvailable: vi.fn(), recordRpcSelfCallRejection: vi.fn(), recordSocketClusterFetchSockets: vi.fn(),
    recordRpcRegistration: vi.fn(), recordRpcUnregistration: vi.fn(),
}));

import { forwardRpcCall } from './forwardRpcCall';
import { buildRpcMethodRoom } from './rpcMethodRoom';

describe('client to daemon RPC reply delivery across Redis adapter nodes', () => {
    let cluster: Awaited<ReturnType<typeof startRedisAdapterRecoveryCluster>>;
    const clients: ClientSocket[] = [];
    beforeAll(async () => { cluster = await startRedisAdapterRecoveryCluster(); });
    afterAll(async () => { await cluster?.close(); });
    afterEach(() => { for (const client of clients.splice(0)) client.disconnect(); });

    async function fixture() {
        const [source, destination] = cluster.nodes;
        const accepted = once(destination.io, 'connection');
        const target = connect(`http://127.0.0.1:${destination.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
        });
        clients.push(target);
        await new Promise<void>(resolve => target.once('connect', resolve));
        const [targetSocket] = await accepted as [Socket];
        const method = `machine-${target.id}:plugin.delivery.read`;
        await targetSocket.join(buildRpcMethodRoom({ userId: 'account-one', method }));
        return { source, target, targetSocket, method };
    }

    it('distinguishes a connected predecessor missing a method from failed discovery and recovers through real forwarding', async () => {
        const { source, target, targetSocket, method } = await fixture();
        const machineId = method.slice(0, method.indexOf(':'));
        const methodRoom = buildRpcMethodRoom({ userId: 'account-one', method });
        const machineRoom = getMachineSocketRoom('account-one', machineId);
        // cli-v0.2.16 / cli-v0.2.16-preview.1, b8d1c449c46ab4dfa8637db36b66f643d149e66d:
        // createMachineSocketTransport.ts authenticates the Machine; RpcHandlerManager.ts
        // registers only installed handlers with { method: `${scopePrefix}:${method}` }.
        // Such a daemon joins its Machine room but never the absent method's room.
        targetSocket.data = { clientType: 'machine-scoped', machineId };
        vi.mocked(db.machine.findFirst).mockResolvedValue({ revokedAt: null, replacedByMachineId: null } as Awaited<ReturnType<typeof db.machine.findFirst>>);
        await targetSocket.join(machineRoom);
        await targetSocket.leave(methodRoom);
        registerSocketRpcHandlers({ userId: 'account-one', socket: targetSocket, io: cluster.nodes[1].io });
        const register = async (method: string) => {
            const registered = once(target, SOCKET_RPC_EVENTS.REGISTERED);
            target.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await registered;
        };
        await register(`${machineId}:capabilities.describe`);
        const relay = (socket: Socket) => {
            socket.on(SOCKET_RPC_EVENTS.CALL, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
                acknowledge(await forwardRpcCall({ io: source.io, targetUserId: 'account-one', method: request.method,
                    callParams: request.params, callerSocketId: socket.id }));
            });
        };
        source.io.on('connection', relay);
        const ui = connect(`http://127.0.0.1:${source.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
        });
        clients.push(ui);
        const call = () => callSocketRpc({ socket: ui, target: { kind: 'machine', id: machineId },
            method: 'plugin.delivery.read', params: {}, content: { mode: 'plain' } });
        try {
            await new Promise<void>(resolve => ui.once('connect', resolve));
            const missing = await call().catch((error: unknown) => error);
            expect(missing).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
            expect(isMachineDaemonRpcUnsupportedError(missing)).toBe(true);

            // Cluster transport is the only discovery mock; keep selection and forwarding real.
            const discovery = vi.spyOn(source.io.of('/').adapter, 'fetchSockets').mockRejectedValue(new Error('cluster timeout'));
            try {
                const unavailable = await call().catch((error: unknown) => error);
                expect(unavailable).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
                expect(isMachineDaemonRpcUnsupportedError(unavailable)).toBe(false);
            } finally {
                discovery.mockRestore();
            }
            await targetSocket.leave(machineRoom);
            const disconnected = await call().catch((error: unknown) => error);
            expect(disconnected).toMatchObject({ rpcErrorCode: 'target_unavailable' });
            expect(isMachineDaemonRpcUnsupportedError(disconnected)).toBe(false);

            await targetSocket.join(machineRoom);
            await register(method);
            target.on(SOCKET_RPC_EVENTS.REQUEST, (_request: unknown, acknowledge: (value: unknown) => void) => acknowledge({ recovered: true }));
            await targetSocket.leave(methodRoom);
            const lostRoom = await call().catch((error: unknown) => error);
            expect(lostRoom).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
            expect(isMachineDaemonRpcUnsupportedError(lostRoom)).toBe(false);
            await targetSocket.join(methodRoom);
            await expect(call()).resolves.toEqual({ recovered: true });
        } finally {
            source.io.off('connection', relay);
            vi.mocked(db.machine.findFirst).mockReset();
        }
    });

    it('delivers the exact daemon reply without waiting for unrelated cluster client counts', async () => {
        const { source, target, method } = await fixture();
        const scopePrefix = method.slice(0, method.indexOf(':'));
        const manager = new RpcHandlerManager({ scopePrefix, encryptionMode: 'plain', logger() {} });
        const handled: unknown[] = [];
        manager.registerHandler('plugin.delivery.read', (value: unknown) => { handled.push(value); return { echoed: value }; });
        target.on(SOCKET_RPC_EVENTS.REQUEST, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
            acknowledge(await manager.handleRequest(request));
        });
        // A subscriber that is not an answering Socket.IO server reproduces the
        // observed cluster census mismatch without replacing discovery or ACK logic.
        const silentSubscriber = source.redis.duplicate();
        const relay = (socket: Socket) => {
            socket.on(SOCKET_RPC_EVENTS.CALL, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
                acknowledge(await forwardRpcCall({ io: source.io, targetUserId: 'account-one', method: request.method,
                    callParams: request.params, timeoutMs: 400, callerSocketId: socket.id,
                    targetGuard: {
                        filterTargets: async targets => targets,
                        runOperation: async ({ operation }) => {
                            // Discovery completes before a nonparticipant joins the census.
                            await silentSubscriber.subscribe('socket.io#/#');
                            return { status: 'current', value: await operation() };
                        },
                    } }));
            });
        };
        source.io.on('connection', relay);
        const ui = connect(`http://127.0.0.1:${source.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
        });
        clients.push(ui);
        try {
            await new Promise<void>(resolve => ui.once('connect', resolve));
            const outcome = await callSocketRpc({ socket: ui, target: { kind: 'machine', id: scopePrefix },
                method: 'plugin.delivery.read', params: { probe: 'reply' }, content: { mode: 'plain' }, timeoutMs: 2_000 })
                .catch((error: unknown) => error);
            expect(handled).toEqual([{ probe: 'reply' }]);
            expect(outcome).toEqual({ echoed: { probe: 'reply' } });
        } finally {
            source.io.off('connection', relay);
            await silentSubscriber.quit();
        }
    });

    it('keeps an old reply bound to the disconnected caller when a new caller reconnects', async () => {
        const { source, target, method } = await fixture();
        const scopePrefix = method.slice(0, method.indexOf(':'));
        let releaseOld!: () => void;
        const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
        let receivedOld!: () => void;
        const oldReceived = new Promise<void>(resolve => { receivedOld = resolve; });
        const dataKey = new Uint8Array(32).fill(19);
        const manager = new RpcHandlerManager({ scopePrefix, encryptionMode: 'e2ee', encryptionKey: dataKey,
            encryptionVariant: 'dataKey', logger() {} });
        manager.registerHandler('plugin.delivery.read', async (value: unknown) => {
            if (value === 'old') { receivedOld(); await oldGate; }
            return { echoed: value };
        });
        target.on(SOCKET_RPC_EVENTS.REQUEST, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
            acknowledge(await manager.handleRequest(request));
        });
        const relay = (socket: Socket) => {
            socket.on(SOCKET_RPC_EVENTS.CALL, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
                acknowledge(await forwardRpcCall({ io: source.io, targetUserId: 'account-one', method: request.method,
                    callParams: request.params, timeoutMs: 2_000, callerSocketId: socket.id }));
            });
        };
        source.io.on('connection', relay);
        const ui = connect(`http://127.0.0.1:${source.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true, autoConnect: false,
        });
        clients.push(ui);
        const connectUi = async () => {
            const connected = new Promise<void>(resolve => ui.once('connect', resolve));
            ui.connect();
            await connected;
        };
        const call = (value: string) => callSocketRpc({ socket: ui, target: { kind: 'machine' as const, id: scopePrefix },
            method: 'plugin.delivery.read', params: value, content: { mode: 'e2ee' as const, cipher: {
                encryptRaw: async (value: unknown) => encodeBase64(encrypt(dataKey, 'dataKey', value)),
                decryptRaw: async (value: string) => decrypt(dataKey, 'dataKey', decodeBase64(value)),
            } }, timeoutMs: 2_000 });
        try {
            await connectUi();
            const oldId = ui.id;
            const oldOutcome = call('old').catch((error: unknown) => error);
            await oldReceived;
            ui.io.engine.close();
            expect(await oldOutcome).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
            await connectUi();
            expect(ui.id).not.toBe(oldId);
            const fresh = call('fresh');
            releaseOld();
            await expect(fresh).resolves.toEqual({ echoed: 'fresh' });
            await expect(call('next')).resolves.toEqual({ echoed: 'next' });
        } finally {
            releaseOld();
            source.io.off('connection', relay);
        }
    });

});
