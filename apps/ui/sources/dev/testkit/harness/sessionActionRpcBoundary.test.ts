import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

vi.mock('socket.io-client', async importOriginal =>
    (await import('./serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { installSessionActionRpcBoundary } from './sessionActionRpcBoundary';

const respond = vi.fn(() => ({ roots: ['/'] }));
const method = `machine:${RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS}`;
const requests = installSessionActionRpcBoundary(respond);
const { io } = await import('socket.io-client');
let socket: ReturnType<typeof io> | undefined;

beforeEach(() => {
    requests.length = 0;
    respond.mockClear();
    socket = io('https://rpc-boundary.fixture.test', { autoConnect: false });
});
afterEach(() => {
    socket?.disconnect();
    socket = undefined;
});

it('delivers a zero-argument plain RPC after JSON omits its undefined params', async () => {
    const result = await socket!.emitWithAck(SOCKET_RPC_EVENTS.CALL, {
        method, params: undefined,
    });

    expect(requests).toEqual([{ method, params: undefined }]);
    expect(respond).toHaveBeenCalledWith(requests[0], expect.objectContaining({ serverUrl: 'https://rpc-boundary.fixture.test' }));
    expect(result).toEqual({ ok: true, result: { roots: ['/'] } });
});

it('still refuses malformed methods and authorization before calling the daemon', async () => {
    await expect(socket!.emitWithAck(SOCKET_RPC_EVENTS.CALL, { params: {} }))
        .rejects.toThrow('Malformed socket RPC request');
    await expect(socket!.emitWithAck(SOCKET_RPC_EVENTS.CALL, {
        method, authorization: { kind: 'unknown' },
    })).rejects.toThrow('Malformed socket RPC authorization');
    expect(respond).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
});
