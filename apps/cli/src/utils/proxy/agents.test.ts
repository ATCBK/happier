import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import axios from 'axios';
import { describe, expect, it } from 'vitest';

import { createDirectHttpAgents } from './agents';

describe('direct HTTP agent idle lifetime', () => {
  it('retires a free socket before the server idle close and succeeds on a fresh connection', async () => {
    const serverKeepAliveTimeoutMs = 1_000;
    const retireBufferMs = 250;
    let connections = 0;
    const server = createServer((_request, response) => {
      // Exercise the client-owned bound even if an intermediary omits the
      // server's Keep-Alive timeout hint.
      response.setHeader('Keep-Alive', 'max=1000');
      response.end('ok');
    });
    server.keepAliveTimeout = serverKeepAliveTimeoutMs;
    server.on('connection', () => { connections += 1; });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected an IP test server address');

    const agents = createDirectHttpAgents({ serverKeepAliveTimeoutMs, retireBufferMs });
    const url = `http://127.0.0.1:${address.port}/idle-race`;
    try {
      await expect(axios.get(url, { proxy: false, httpAgent: agents.httpAgent, adapter: 'http' }))
        .resolves.toMatchObject({ status: 200 });
      await delay(serverKeepAliveTimeoutMs - retireBufferMs + 10);
      await expect(axios.get(url, { proxy: false, httpAgent: agents.httpAgent, adapter: 'http' }))
        .resolves.toMatchObject({ status: 200 });
      expect(connections).toBe(2);
    } finally {
      agents.httpAgent.destroy();
      agents.httpsAgent.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
