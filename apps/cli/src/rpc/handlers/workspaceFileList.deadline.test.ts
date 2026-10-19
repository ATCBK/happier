import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { afterEach, expect, it, vi } from 'vitest';
import { callSocketRpc } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonWorkspaceFileListResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerSessionHandlers } from './registerSessionHandlers';

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn(async () => {}) }));
// Deterministically slow OS process boundary; registration, codec, transport,
// request lifecycle, handler, buffering and strict consumer all remain real.
vi.mock('child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('child_process')>(), spawn: boundary.spawn,
}));
vi.mock('@/packagedRuntime/js/requireJavaScriptRuntimeExecutable', () => ({
    requireJavaScriptRuntimeExecutable: async () => process.execPath,
}));
vi.mock('@/processes/terminate/terminateProcessTree', () => ({ terminateProcessTree: boundary.terminate }));

afterEach(() => vi.clearAllMocks());

it.each(['tmp/fsp-find-review/target.txt\nunfinished', ''])('returns a bounded incomplete page at the supplied operation budget (%j)', async (output) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4245 });
    boundary.spawn.mockImplementation(() => {
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(output)));
        return child; // Traversal does not complete before its owning budget.
    });
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
    const registration = registerSessionHandlers(rpc, '/tmp');
    const http = createServer();
    const relay = new Server(http);
    relay.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL,
        async (request: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            ack({ ok: true, result: await rpc.handleRequest(request) });
        }));
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const socket = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    await new Promise<void>(resolve => socket.once('connect', resolve));
    try {
        const response = await callSocketRpc({ socket, target: { kind: 'machine', id: 'machine' },
            method: RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST,
            params: { rootPath: '/', query: 'fsp-find-review', budgetMs: 50 },
            timeoutMs: null, content: { mode: 'plain' } });
        expect(DaemonWorkspaceFileListResponseSchema.parse(response)).toEqual({
            ok: true, paths: output ? ['tmp/fsp-find-review/target.txt'] : [], truncated: true,
        });
        expect(boundary.terminate).toHaveBeenCalledWith(child);
    } finally {
        child.emit('close', 143);
        socket.disconnect();
        await new Promise<void>(resolve => relay.close(() => resolve()));
        await registration.dispose();
    }
});
