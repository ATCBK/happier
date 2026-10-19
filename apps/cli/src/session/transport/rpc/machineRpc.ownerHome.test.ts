import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';

import type { ClientToServerEvents, ServerToClientEvents } from '@/api/types';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { callMachineRpc } from './machineRpc';

const homes: Array<Readonly<{ close(): Promise<void> }>> = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => home.close())); });

async function createHome(ownerToken: string | null) {
  const requests: Array<Readonly<{ path: string | undefined; authorization: string | undefined }>> = [];
  const calls: string[] = [];
  const socketTokens: unknown[] = [];
  const http = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (ownerToken === null || request.headers.authorization !== `Bearer ${ownerToken}`) {
      response.writeHead(401).end('{}');
    } else if (request.url === '/v1/machines?includeRevoked=true') {
      response.end(JSON.stringify([{ id: 'old', replacedByMachineId: 'current' }, { id: 'current' }]));
    } else if (request.url === '/v1/machines/old' || request.url === '/v1/machines/current') {
      response.end(JSON.stringify({ machine: { id: request.url.endsWith('/old') ? 'old' : 'current',
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } }));
    } else { response.writeHead(404).end('{}'); }
  });
  const socketServer = new Server<ClientToServerEvents, ServerToClientEvents>(http, { path: '/v1/updates' });
  socketServer.use((socket, next) => {
    const token: unknown = socket.handshake.auth.token;
    socketTokens.push(token);
    next(ownerToken !== null && token === ownerToken ? undefined : new Error('Unauthorized fixture Account'));
  });
  socketServer.on('connection', socket => {
    socket.on(SOCKET_RPC_EVENTS.CALL, (request, acknowledge) => {
      calls.push(request.method);
      acknowledge(request.method === 'old:status'
        ? { ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }
        : { ok: true, result: { status: 'running' } });
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture Home address');
  const home = { url: `http://127.0.0.1:${address.port}`, requests, calls, socketTokens,
    close: () => new Promise<void>(resolve => socketServer.close(() => resolve())) };
  homes.push(home);
  return home;
}

describe('Machine RPC replacement Home custody', () => {
  it('keeps the replacement lookup and successful retry on the captured Home', async () => {
    const credentials = { token: 'captured-owner-account', encryption: null } as const;
    const owner = await createHome(credentials.token);
    const focused = await createHome(null);
    const result = await runWithServerHttpBaseUrl(focused.url, async () => await callMachineRpc({
      credentials, machineId: 'old', serverUrl: owner.url, method: 'status', request: { ping: true },
    }).catch((error: unknown) => error));

    expect(focused.requests).toEqual([]);
    expect(focused.socketTokens).toEqual([]);
    expect(result).toEqual({ status: 'running' });
    expect(owner.requests).toEqual(['/v1/machines/old', '/v1/machines?includeRevoked=true', '/v1/machines/current']
      .map(path => ({ path, authorization: `Bearer ${credentials.token}` })));
    expect(owner.calls).toEqual(['old:status', 'current:status']);
    expect(owner.socketTokens).toEqual([credentials.token, credentials.token]);
  });
});
