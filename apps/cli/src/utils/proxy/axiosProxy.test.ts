import { createServer, globalAgent } from 'node:http';

import axios from 'axios';
import { describe, it, expect } from 'vitest';

import { getAxiosProxyOptionsForUrl } from './axiosProxy';

describe('getAxiosProxyOptionsForUrl', () => {
  it('always disables axios native proxy handling', () => {
    const opts = getAxiosProxyOptionsForUrl({ targetUrl: 'https://example.com', env: {} as NodeJS.ProcessEnv });
    expect(opts.proxy).toBe(false);
    expect(opts.httpAgent).toBeTruthy();
    expect(opts.httpsAgent).toBeTruthy();
  });

  it('returns an httpsAgent when a proxy applies', () => {
    const env = { HTTPS_PROXY: 'http://proxy.local:3128' } as NodeJS.ProcessEnv;
    const opts = getAxiosProxyOptionsForUrl({ targetUrl: 'https://example.com', env });
    expect(opts.proxy).toBe(false);
    expect((opts as any).httpsAgent).toBeTruthy();
  });

  it('uses direct agents when NO_PROXY bypasses the configured proxy', () => {
    const env = { HTTPS_PROXY: 'http://proxy.local:3128', NO_PROXY: '*' } as NodeJS.ProcessEnv;
    const opts = getAxiosProxyOptionsForUrl({ targetUrl: 'https://example.com', env });
    expect(opts.proxy).toBe(false);
    expect(opts.httpAgent).toBeTruthy();
    expect(opts.httpsAgent).toBeTruthy();
  });

  it('reuses one direct connection for a settled minute of sequential requests', async () => {
    let connections = 0;
    let requestsServed = 0;
    const server = createServer((_request, response) => {
      requestsServed += 1;
      response.end('ok');
    });
    server.on('connection', () => { connections += 1; });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected an IP test server address');

    const previousGlobalKeepAlive = globalAgent.keepAlive;
    globalAgent.keepAlive = false;
    const targetUrl = `http://127.0.0.1:${address.port}/idle-probe`;
    const options = getAxiosProxyOptionsForUrl({ targetUrl, env: {} as NodeJS.ProcessEnv });
    try {
      for (let request = 0; request < 60; request += 1) {
        await axios.get(targetUrl, { ...options, adapter: 'http' });
      }
      expect(requestsServed).toBe(60);
      expect(connections).toBe(1);
    } finally {
      globalAgent.keepAlive = previousGlobalKeepAlive;
      const directAgent = options.httpAgent;
      if (directAgent && typeof directAgent === 'object' && 'destroy' in directAgent
        && typeof directAgent.destroy === 'function') directAgent.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

