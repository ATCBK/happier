import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

// The shipped runtime bundles undici as CommonJS (`export default require_undici()`), so a
// bundled `import('undici')` exposes only `default`; Node source also exposes named exports.
// The daemon control client must dial the control port under the bundled shape.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { default: { Agent: actual.Agent } };
});

import { readDaemonControlHttpResponse } from './controlHttp';

describe('daemon control HTTP under the bundled undici module shape', () => {
  it('reaches the daemon control port', async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing server address');
    try {
      await expect(
        readDaemonControlHttpResponse({
          httpPort: address.port,
          path: '/ping',
          body: {},
          headers: {},
        }),
      ).resolves.toEqual({ ok: true, status: 200, body: '{"ok":true}' });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
