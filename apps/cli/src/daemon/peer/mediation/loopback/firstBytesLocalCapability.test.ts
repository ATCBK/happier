import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startFirstBytesLocalCapabilityProxy } from './firstBytesLocalCapability';

const closeTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeTasks.splice(0).map(close => close()));
});

describe('first-bytes capability proxy stream closure', () => {
  it.each([
    { payload: '', response: '' },
    { payload: 'request', response: 'response' },
  ])('forwards caller EOF and preserves a half-close response (payload=$payload)', async ({ payload, response }) => {
    const sockets = new Set<Socket>();
    const applicationBytes: Buffer[] = [];
    let applicationConnections = 0;
    let applicationReceivedEof = false;
    const upstream = createServer({ allowHalfOpen: true }, socket => {
      applicationConnections++;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('data', (chunk: Buffer) => applicationBytes.push(chunk));
      socket.once('end', () => {
        applicationReceivedEof = true;
        socket.end(response);
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    closeTasks.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Application listener unavailable');
    const proxy = await startFirstBytesLocalCapabilityProxy({ targetPort: address.port });
    closeTasks.push(proxy.close);
    const caller = connect({ host: '127.0.0.1', port: proxy.port });
    const responseBytes: Buffer[] = [];
    caller.on('data', (chunk: Buffer) => responseBytes.push(chunk));
    closeTasks.push(async () => { caller.destroy(); });
    await once(caller, 'connect');
    const callerClosed = once(caller, 'close');

    // No HTTP or application bytes follow the capability. This can finish
    // before the proxy's outbound application connection has connected.
    caller.end(proxy.localCapability + payload, 'ascii');

    await vi.waitFor(() => expect(applicationConnections).toBe(1));
    await vi.waitFor(() => expect(applicationReceivedEof).toBe(true));
    await proxy.closed;
    await callerClosed;
    expect(Buffer.concat(applicationBytes).toString('utf8')).toBe(payload);
    expect(Buffer.concat(responseBytes).toString('utf8')).toBe(response);
  });
});
