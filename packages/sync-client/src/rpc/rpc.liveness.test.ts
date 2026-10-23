import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHappierSocket } from '../socket/createHappierSocket.js';
import { callSocketRpc } from './callSocketRpc.js';
import { readRpcRequestDisposition } from './rpcDisposition.js';

// The server must keep servicing its heartbeat while only the client is stalled.
// A worker supplies that real scheduling boundary; the short heartbeat is a
// fixture acceleration, not an alternative product liveness policy.
const serverSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { createServer } = require('node:http');
const { Server } = require(workerData.socketIoPath);
const http = createServer();
const io = new Server(http, { path: '/v1/updates/', pingInterval: 100, pingTimeout: 400 });
const wake = new Int32Array(workerData.wake);
let effects = 0;
let calls = 0;
let pendingReply;
io.on('connection', socket => {
  socket.on('disconnect', reason => {
    Atomics.store(wake, 0, 1);
    Atomics.notify(wake, 0);
    parentPort.postMessage({ kind: 'closed', reason });
  });
  socket.on('rpc-call', (request, ack) => {
    calls++;
    if (request.method.endsWith(':' + workerData.writeMethod)) {
      effects++;
      pendingReply = ack;
      parentPort.postMessage({ kind: 'applied' });
    } else {
      if (pendingReply) { pendingReply({ ok: true, result: { late: true } }); pendingReply = null; }
      ack({ ok: true, result: { effects, calls } });
    }
  });
});
parentPort.on('message', command => {
  if (command === 'drop') for (const socket of io.sockets.sockets.values()) socket.conn.close();
});
http.listen(0, '127.0.0.1', () => parentPort.postMessage({ kind: 'ready', port: http.address().port }));
`;

it.each(['client event-loop stall', 'physical transport loss'] as const)(
  'settles an issued write across %s without replaying or adopting its old ACK',
  async failureMode => {
    const wake = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(serverSource, { eval: true, workerData: {
      socketIoPath: createRequire(import.meta.url).resolve('socket.io'),
      writeMethod: RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2, wake: wake.buffer,
    } });
    let transport: ReturnType<typeof createHappierSocket>['transport'] | undefined;
    try {
      const [ready] = await once(worker, 'message') as [{ kind: string; port: number }];
      expect(ready.kind).toBe('ready');
      const client = createHappierSocket({ endpoint: `http://127.0.0.1:${ready.port}`,
        token: 'fixture', clientType: 'user-scoped', transports: ['websocket'] });
      transport = client.transport;
      await transport.connect();
      const originalSocketId = client.socket.id;
      const applied = once(worker, 'message');
      const pending = callSocketRpc({ socket: client.socket, target: { kind: 'machine', id: 'm' },
        method: RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2, params: { sessionId: 's', objective: 'fixture' },
        content: { mode: 'plain' }, timeoutMs: null }).catch((error: unknown) => error);
      expect((await applied)[0]).toEqual({ kind: 'applied' });
      const closed = once(worker, 'message');
      if (failureMode === 'client event-loop stall') {
        // The independently scheduled server releases the client only after
        // the real Engine.IO heartbeat closes the connection. No fake clock.
        expect(Atomics.wait(wake, 0, 0, 5000)).not.toBe('timed-out');
      } else worker.postMessage('drop');
      const error = await pending;
      expect((await closed)[0]).toEqual({ kind: 'closed',
        reason: failureMode === 'client event-loop stall' ? 'ping timeout' : 'forced close' });
      expect(error).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
      expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
      expect(client.socket.sendBuffer).toEqual([]);
      expect(client.socket).toHaveProperty('acks', {});
      await transport.connect();
      expect(client.socket.id).not.toBe(originalSocketId);
      // A fresh read reconciles the applied write. The old server callback is
      // invoked here too, proving that reconnect does not recover that ACK.
      await expect(callSocketRpc({ socket: client.socket, target: { kind: 'machine', id: 'm' },
        method: RPC_METHODS.DAEMON_SESSION_GOAL_GET, params: { sessionId: 's' },
        content: { mode: 'plain' }, timeoutMs: null })).resolves.toEqual({ effects: 1, calls: 2 });
    } finally {
      await transport?.destroy();
      await worker.terminate();
    }
  },
);
