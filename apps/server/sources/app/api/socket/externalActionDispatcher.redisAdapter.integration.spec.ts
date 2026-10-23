import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { ClusterAdapter, MessageType, type ClusterMessage } from 'socket.io-adapter';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { createExternalActionDaemonDispatchResponseV1, prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

import { getAccountSessionSocketRoom } from '@/app/api/socketRooms';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { startRedisAdapterRecoveryCluster } from '@/testkit/redisAdapterRecoveryCluster';
import { buildRpcMethodRoom } from './rpc/rpcMethodRoom';
import { registerSocketRpcHandlers } from './rpc/registerSocketRpcHandlers';
import { createExternalActionDaemonDispatcher, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from './externalActionDispatcher';

describe('Session Action placement and reconnect with a silent unrelated Redis peer', () => {
    let harness: LightSqliteHarness;
    let cluster: Awaited<ReturnType<typeof startRedisAdapterRecoveryCluster>> | undefined;
    const clients: ClientSocket[] = [];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-c133-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: `srv_${'c'.repeat(32)}` } });
    }, 120_000);
    afterEach(async () => {
        for (const client of clients.splice(0)) client.disconnect();
        vi.restoreAllMocks();
        await cluster?.close();
        cluster = undefined;
        harness.resetEnv();
    });
    afterAll(async () => { await harness?.close(); });

    async function setup() {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            installationId: randomUUID(), installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'c133', platform: 'linux' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            active: true, lastActiveAt: new Date(),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', active: false } });
        const binding = { accountId: account.id, machineId: machine.id, sessionId: session.id };
        await db.accessKey.create({ data: { ...binding, data: 'opaque-key' } });
        const presence = createSessionPublisherPresence();
        cluster = await startRedisAdapterRecoveryCluster({ nodeCount: 3 });
        const open = async (index: number) => {
            const node = cluster!.nodes[index]!;
            const joined = new Promise<import('socket.io').Socket>(resolve => node.io.once('connection', resolve));
            const socketAuth = buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION);
            const client = connect(`http://127.0.0.1:${node.port}`, {
                path: '/v1/updates', transports: ['websocket'], reconnection: false,
                auth: socketAuth,
            });
            clients.push(client);
            const socket = await joined;
            // This harness owns the handshake boundary; preserve the production
            // admission projection needed by plain-content Machine RPCs.
            writeAccountStoredContentCompatibilityForSocket(socket,
                evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            return { client, socket };
        };
        const stale = await open(0);
        const publisher = await open(1);
        for (const { socket } of [stale, publisher]) {
            await socket.join(getAccountSessionSocketRoom(account.id, session.id));
            const registration = await presence.registerPublisher({ socket, binding,
                completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
            expect(registration, JSON.stringify(registration, (_, value) => typeof value === 'bigint' ? value.toString() : value))
                .toMatchObject({ status: 'registered' });
        }
        const daemon = await open(1);
        Object.assign(daemon.socket.data, { userId: account.id, clientType: 'machine-scoped', machineId: machine.id,
            verifiedMachineInstallationId: machine.installationId });
        await daemon.socket.join(buildRpcMethodRoom({ userId: account.id,
            method: `${machine.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}` }));
        let effects = 0;
        daemon.client.on(SOCKET_RPC_EVENTS.REQUEST, (_request: unknown, ack: (value: unknown) => void) => {
            effects++;
            ack(createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                v: 1, actionId: 'session.stop', requestId: 'c133-action', execution: { ok: true, result: { stopped: true } },
            })));
        });
        const adapter = cluster.nodes[2]!.io.sockets.adapter;
        if (!(adapter instanceof ClusterAdapter)) throw new Error('Expected real cluster adapter');
        // Only the external adapter inbound boundary is held; this peer remains counted.
        const receiver = adapter as unknown as { onMessage(message: ClusterMessage, offset?: string): void };
        const onMessage = receiver.onMessage.bind(receiver);
        vi.spyOn(receiver, 'onMessage').mockImplementation((message, offset) => {
            if (message.type === MessageType.FETCH_SOCKETS || message.type === MessageType.SERVER_SIDE_EMIT) return;
            onMessage(message, offset);
        });
        const dispatch = createExternalActionDaemonDispatcher({ io: cluster.nodes[0].io, sessionPublisherPresence: presence });
        const run = () => dispatch({ actionId: 'session.stop',
            envelope: { v: 1, requestId: 'c133-action', target: { kind: 'session', sessionId: session.id }, input: {} },
            principal: { accountId: account.id, authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
                authority: 'present_user' } });
        return { account, machine, session, binding, presence, publisher, stale, daemon, open, run, effects: () => effects };
    }

    it('dispatches only through the current remote publisher despite a stale local publisher and a silent peer', async () => {
        const test = await setup();
        expect(await test.run()).toMatchObject({ kind: 'response' });
        expect(test.effects()).toBe(1);
    });

    it.each(['replacement', 'access revocation', 'machine replacement'] as const)(
        'refuses effects after %s while the publisher reply is in flight', async change => {
            const test = await setup();
            const io = cluster!.nodes[1].io;
            const emit = io.serverSideEmit.bind(io);
            let changed = false;
            let mutation: Promise<unknown> | undefined;
            // Hold the real transport's positive reply after it captured the old projection.
            vi.spyOn(io, 'serverSideEmit').mockImplementation((event, ...args) => {
                if (!changed && event.startsWith('happier:socket-room:response:')) {
                    changed = true;
                    const captured = structuredClone(args);
                    mutation = (async () => {
                        if (change === 'replacement') {
                            expect(await test.presence.registerPublisher({ socket: { data: {} }, binding: test.binding,
                                completeActivitySnapshot: { state: 'idle', activeCount: 0 } })).toMatchObject({ status: 'registered' });
                        } else if (change === 'access revocation') {
                            await db.accessKey.deleteMany({ where: test.binding });
                        } else {
                            const successor = await db.machine.create({ data: { id: randomUUID(), accountId: test.account.id, metadata: '{}' } });
                            await db.machine.update({ where: { id: test.machine.id }, data: { replacedByMachineId: successor.id } });
                        }
                        emit(event, ...captured);
                    })();
                    return true;
                }
                return emit(event, ...args);
            });
            expect(await test.run()).toMatchObject({ kind: 'placement_error', code: 'target_unavailable' });
            await mutation;
            expect(changed).toBe(true);
            expect(test.effects()).toBe(0);
        },
    );

    it('hydrates positive REGISTERED hints on reconnect without claiming UNREGISTERED from a failed census', async () => {
        const test = await setup();
        const method = `${test.machine.id}:${RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME}`;
        const registerUi = async () => {
            const ui = await test.open(1);
            Object.assign(ui.socket.data, { userId: test.account.id, clientType: 'user-scoped' });
            await ui.socket.join(`user:${test.account.id}`);
            registerSocketRpcHandlers({ userId: test.account.id, socket: ui.socket, io: cluster!.nodes[1].io });
            const registered = new Promise<void>(resolve => ui.client.once(SOCKET_RPC_EVENTS.REGISTERED, () => resolve()));
            ui.client.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await registered;
            return ui;
        };
        const first = await registerUi();
        await registerUi();
        const reconnect = await test.open(0);
        Object.assign(reconnect.socket.data, { userId: test.account.id, clientType: 'machine-scoped', machineId: test.machine.id });
        await reconnect.socket.join(`machine:${test.machine.id}:${test.account.id}`);
        const registered: unknown[] = [];
        const unregistered: unknown[] = [];
        reconnect.client.on(SOCKET_RPC_EVENTS.REGISTERED, value => registered.push(value));
        reconnect.client.on(SOCKET_RPC_EVENTS.UNREGISTERED, value => unregistered.push(value));
        registerSocketRpcHandlers({ userId: test.account.id, socket: reconnect.socket, io: cluster!.nodes[0].io });
        await vi.waitFor(() => expect(registered).toContainEqual({ method }), { timeout: 10_000 });
        const adapter = cluster!.nodes[1].io.sockets.adapter;
        const fetch = adapter.fetchSockets.bind(adapter);
        let censusFailed!: () => void;
        const failureObserved = new Promise<void>(resolve => { censusFailed = resolve; });
        vi.spyOn(adapter, 'fetchSockets').mockImplementation(async options => {
            try { return await fetch(options); }
            catch (error) {
                if (options.rooms.has(buildRpcMethodRoom({ userId: test.account.id, method }))) censusFailed();
                throw error;
            }
        });
        const unregisterAcknowledged = new Promise<void>(resolve => {
            first.client.once(SOCKET_RPC_EVENTS.UNREGISTERED, () => resolve());
        });
        first.client.emit(SOCKET_RPC_EVENTS.UNREGISTER, { method });
        await Promise.all([failureObserved, unregisterAcknowledged]);
        // Observe a later packet on the same cluster publication path before
        // asserting absence; a queued false hint must not escape this check.
        const barrierReceived = new Promise<void>(resolve => {
            reconnect.client.once('c133-unregister-settled', () => resolve());
        });
        cluster!.nodes[1].io.to(reconnect.socket.id).emit('c133-unregister-settled');
        await barrierReceived;
        expect(unregistered).toEqual([]);
    });
});
