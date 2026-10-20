import { createServer, get } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlRequestLifetime } from './controlRequestLifetime';

describe('daemon control request response lifetime', () => {
  it.each(['interrupted', 'delivered'] as const)('settles an %s response by actual write completion', async (delivery) => {
    type ResponseState = { ended: boolean; finished: boolean; aborted: boolean; writePending: boolean };
    let observeClosed!: (state: ResponseState) => void;
    const closed = new Promise<ResponseState>(resolve => { observeClosed = resolve; });
    const server = createServer(async (request, response) => {
      // Fastify consumes the request body before entering a control handler.
      await new Promise<void>(resolve => { request.once('end', resolve); request.resume(); });
      // Only the native HTTP boundary is supplied here; cancellation logic is real.
      const lifetime = createDaemonControlRequestLifetime({ raw: request } as FastifyRequest, { raw: response } as FastifyReply);
      const socket = response.socket;
      if (!socket) throw new Error('Expected connected HTTP socket');
      let writePending = false;
      // Hold the OS write completion rather than relying on a payload exceeding
      // the host's socket buffers. HTTP/stream completion and cancellation stay real.
      const writes = delivery === 'interrupted' ? [
        vi.spyOn(socket, '_write').mockImplementation(() => { writePending = true; }),
        vi.spyOn(socket, '_writev').mockImplementation(() => { writePending = true; }),
      ] : [];
      response.once('close', () => {
        observeClosed({ ended: response.writableEnded, finished: response.writableFinished, aborted: lifetime.signal.aborted, writePending });
        writes.forEach(write => write.mockRestore());
        lifetime.dispose();
      });
      response.end(delivery);
      if (delivery === 'interrupted') socket.destroy();
    });
    try {
      await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected HTTP test address');
      const client = get(`http://127.0.0.1:${address.port}`, response => {
        response.on('error', () => undefined);
        response.resume();
      });
      client.on('error', () => undefined);
      const state = await closed;
      expect(state.ended).toBe(true);
      expect(state.writePending).toBe(delivery === 'interrupted');
      expect(state.finished).toBe(delivery === 'delivered');
      expect(state.aborted).toBe(delivery === 'interrupted');
    } finally {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
    }
  });
});
