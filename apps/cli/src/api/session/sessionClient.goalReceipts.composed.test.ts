import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createHappierSocket, socketRpcCodec } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readGoalOperationResult } from '../../../../ui/sources/sync/ops/sessionGoalOperationResult';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { resolveSessionRpcContent } from '@/session/transport/rpc/sessionRpc';
import { ApiSessionClient } from './sessionClient';

// The Account socket is an unrelated network boundary; the Session reply uses
// real Socket.IO, registration, controls, dispatch, codec and UI consumption.
vi.mock('./sockets', () => ({ createUserScopedSocket: () => createApiSessionSocketStub({ connected: true }) }));

describe('Session Goal terminal transport receipts', () => {
  it('retains Goal controls after a refused Set and re-registers them after socket recovery', async () => {
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { session: {
      runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 }, publisherAuthority: { protocolVersion: 1 },
    } } });
    const http = createServer((request, response) => {
      response.writeHead(request.url === '/v1/features' || request.url === '/v1/auth/ping' ? 200 : 404,
        { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.url === '/v1/features' ? features : {}));
    });
    const server = new Server(http, { path: '/v1/updates/' });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing socket endpoint');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const sessionId = 'recovered-goal';
    const transcriptHome = createSessionTranscriptHomeStub();
    const activityHome = createSessionRuntimeActivityHomeStub({ machineId: 'fixture-machine' });
    const registrations = new Map<import('socket.io').Socket, Set<string>>();
    server.on('connection', socket => {
      const methods = new Set<string>();
      registrations.set(socket, methods);
      // Home's network boundary records registrations per connection. A new
      // transport cannot inherit the old socket's registry in this harness.
      socket.on(SOCKET_RPC_EVENTS.REGISTER, ({ method }: { method: string }) => {
        methods.add(method);
        socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
      });
      socket.on(SOCKET_RPC_EVENTS.UNREGISTER, ({ method }: { method: string }) => methods.delete(method));
      socket.onAny((event, payload, ack) => {
        const answer = transcriptHome.answer(event, payload) ?? activityHome.answer(event, payload);
        if (answer !== null && typeof ack === 'function') ack(answer);
      });
    });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: sessionId }), {
      durableMutationDeliveryInitiallyActive: false,
      localMachineId: 'fixture-machine',
      transport: { serverId: 'fixture-home', serverUrl: endpoint,
        createSessionSocketTransport: () => createHappierSocket({ endpoint, token: 'test-token',
          clientType: 'session-scoped', sessionId, transports: ['websocket'] }) },
    });
    client.setSessionRuntimeControls({
      setGoal: async () => ({ ok: false, errorCode: 'session_goal_control_work_state_unavailable',
        error: 'session_goal_control_work_state_unavailable', goalControlFailure: { phase: 'missing_matching_publication' } }),
      refreshGoal: async () => undefined,
      clearGoal: async () => undefined,
    });
    const goalMethods = [SESSION_RPC_METHODS.SESSION_GOAL_SET, SESSION_RPC_METHODS.SESSION_GOAL_GET,
      SESSION_RPC_METHODS.SESSION_GOAL_CLEAR];
    const registeredSocket = async (previous?: import('socket.io').Socket) => {
      let current: import('socket.io').Socket | undefined;
      await expect.poll(() => {
        current = [...registrations.keys()].find(socket => socket !== previous && socket.connected
          && goalMethods.every(method => registrations.get(socket)?.has(`${sessionId}:${method}`)));
        return current !== undefined;
      }, { timeout: 5_000 }).toBe(true);
      if (!current) throw new Error('Missing registered Goal transport');
      return current;
    };
    const request = async (socket: import('socket.io').Socket, method: string, params: unknown = {}) => {
      if (!registrations.get(socket)?.has(`${sessionId}:${method}`)) {
        return { error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
      }
      return await socket.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
        method: `${sessionId}:${method}`, params, timeoutMs: null,
      });
    };
    try {
      const first = await registeredSocket();
      await expect(request(first, SESSION_RPC_METHODS.SESSION_GOAL_SET, { objective: 'Refused native Goal' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'session_goal_control_work_state_unavailable' });
      await expect(request(first, SESSION_RPC_METHODS.SESSION_GOAL_GET)).resolves.toEqual({ workState: null });
      await expect(request(first, SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)).resolves.toEqual({ workState: null });
      first.conn.close();
      const recovered = await registeredSocket(first);
      await expect(request(recovered, SESSION_RPC_METHODS.SESSION_GOAL_GET)).resolves.toEqual({ workState: null });
      await expect(request(recovered, SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)).resolves.toEqual({ workState: null });
      await expect(request(recovered, SESSION_RPC_METHODS.SESSION_GOAL_SET, { objective: 'Still reaches native owner' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'session_goal_control_work_state_unavailable' });
    } finally {
      await client.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['initialization', 'native-control', 'retiring-handler'] as const)('delivers the %s terminal RPC receipt before closing its real socket', async phase => {
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { session: {
      runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 }, publisherAuthority: { protocolVersion: 1 },
    } } });
    const http = createServer((request, response) => {
      response.writeHead(request.url === '/v1/features' ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.url === '/v1/features' ? features : {}));
    });
    const server = new Server(http, { path: '/v1/updates/' });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing socket endpoint');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const transcriptHome = createSessionTranscriptHomeStub();
    const activityHome = createSessionRuntimeActivityHomeStub({ machineId: 'fixture-machine' });
    const connected = new Promise<import('socket.io').Socket>(resolve => server.once('connection', socket => {
      socket.onAny((event, payload, ack) => {
        const answer = transcriptHome.answer(event, payload) ?? activityHome.answer(event, payload);
        if (answer !== null && typeof ack === 'function') ack(answer);
      });
      resolve(socket);
    }));
    const connection = createHappierSocket({ endpoint, token: 'test-token', clientType: 'session-scoped',
      sessionId: 'resumed-goal', transports: ['websocket'] });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 'resumed-goal' }), {
      durableMutationDeliveryInitiallyActive: false,
      localMachineId: 'fixture-machine',
      transport: { serverId: 'fixture-home', serverUrl: endpoint, createSessionSocketTransport: () => connection },
    });
    const contractReady = new Promise<void>(resolve => client.once('session-sync-server-contract', () => resolve()));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const admission = new Promise<void>(resolve => { entered = resolve; });
    let localEntered!: () => void;
    const localAdmission = new Promise<void>(resolve => { localEntered = resolve; });
    let hasEntered = false;
    let retired!: () => void;
    const retirement = new Promise<void>(resolve => { retired = resolve; });
    const method = phase === 'retiring-handler' ? 'fixture.wait' : SESSION_RPC_METHODS.SESSION_GOAL_GET;
    // Hold the admitted handler at its real runtime boundary while close starts.
    // An unsupported runtime result must remain a failure all the way to Home.
    if (phase === 'native-control') {
      client.setSessionRuntimeControls({ refreshGoal: async () => {
        if (hasEntered) localEntered();
        else { hasEntered = true; entered(); }
        await held;
        return { ok: false, errorCode: 'unsupported_session_runtime_method', error: 'unsupported_session_runtime_method' };
      } });
    }
    if (phase === 'retiring-handler') {
      // A registered leaf may still be releasing its external resource after
      // cancellation. Keep its terminal receipt while refusing fresh dispatch.
      client.rpcHandlerManager.registerHandler(method, async (_request, context) => {
        context?.signal.addEventListener('abort', retired, { once: true });
        entered();
        await held;
        return { error: 'fixture terminal failure' };
      });
    }
    try {
      const socket = await connected;
      await contractReady;
      const receipt = socket.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
        method: `resumed-goal:${method}`, params: {}, timeoutMs: null,
      });
      // Observe a rejection immediately, even if the intended RED closes early.
      const observedReceipt = receipt.then(value => ({ value }), (error: unknown) => ({ error }));
      if (phase !== 'initialization') await admission;
      else await expect.poll(() => client.rpcHandlerManager.getInFlightRequestCount()).toBe(1);
      let localSettled = false;
      const localReceipt = phase === 'native-control'
        ? client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_GOAL_GET, {}).finally(() => { localSettled = true; })
        : null;
      if (localReceipt) await localAdmission;
      const closing = client.close();
      if (phase === 'retiring-handler') {
        expect(await Promise.race([retirement.then(() => 'cancelled'), closing.then(() => 'closed')])).toBe('cancelled');
        const refusal = await socket.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
          method: `resumed-goal:${SESSION_RPC_METHODS.SESSION_GOAL_GET}`, params: {}, timeoutMs: null,
        });
        expect(refusal).toEqual({ error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        await expect(socketRpcCodec.decodeResult(resolveSessionRpcContent({ ctx: {
          encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
        } }), { ok: true, result: refusal }, '0123456789abcdef0123456789abcdef'))
          .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        release();
      }
      await closing;
      const result = await observedReceipt;
      expect(result).toEqual({ value: phase === 'initialization'
        ? { ok: false, errorCode: 'unsupported_session_runtime_method', error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_GOAL_GET}` }
        : { error: phase === 'native-control' ? 'RPC target transport disconnected' : 'fixture terminal failure' } });
      if (!('value' in result)) throw result.error;
      expect(readGoalOperationResult(result.value)).toMatchObject({ ok: false });
      // Socket retirement must not wait on an unrelated in-process observation.
      if (localReceipt) {
        expect(localSettled).toBe(false);
        release();
        await expect(localReceipt).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_session_runtime_method' });
      }
    } finally {
      release();
      await client.close();
      await connection.transport.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
