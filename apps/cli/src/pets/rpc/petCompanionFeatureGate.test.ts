import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';
import { configuration } from '@/configuration';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';

type FeatureServer = Readonly<{
  url: string;
  close: () => Promise<void>;
}>;

function isAddressInfo(address: string | AddressInfo | null): address is AddressInfo {
  return typeof address === 'object' && address !== null;
}

async function startFeatureServer(companionEnabled: boolean): Promise<FeatureServer> {
  const server: Server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/v1/features') {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      features: {
        pets: {
          companion: { enabled: companionEnabled },
        },
      },
      capabilities: {},
    }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!isAddressInfo(address)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    throw new Error('expected test feature server to listen on a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

describe('petCompanionFeatureGate', () => {
  it('reads the published runtime endpoint when the configured API endpoint is unavailable', async () => {
    const unreachable = await startFeatureServer(false);
    const server = await startFeatureServer(true);
    const previous = configuration.apiServerUrl;
    await unreachable.close();
    Object.assign(configuration, { apiServerUrl: unreachable.url });
    const release = publishServerHttpRuntimeOrigin(server.url, 'iroh');
    try {
      const { resolvePetCompanionFeatureEnabled } = await import('./petCompanionFeatureGate');
      await expect(resolvePetCompanionFeatureEnabled({ env: {} })).resolves.toBe(true);
    } finally {
      release();
      Object.assign(configuration, { apiServerUrl: previous });
      await server.close();
    }
  });

  it('resolves pets.companion as disabled from the server feature snapshot', async () => {
    const server = await startFeatureServer(false);
    try {
      const mod = await import('./petCompanionFeatureGate');

      expect(mod.resolvePetCompanionFeatureEnabled).toBeTypeOf('function');
      await expect(mod.resolvePetCompanionFeatureEnabled({
        env: {},
        serverUrl: server.url,
        timeoutMs: 1_000,
      })).resolves.toBe(false);
    } finally {
      await server.close();
    }
  });

  it('resolves pets.companion as enabled from the server feature snapshot', async () => {
    const server = await startFeatureServer(true);
    try {
      const mod = await import('./petCompanionFeatureGate');

      expect(mod.resolvePetCompanionFeatureEnabled).toBeTypeOf('function');
      await expect(mod.resolvePetCompanionFeatureEnabled({
        env: {},
        serverUrl: server.url,
        timeoutMs: 1_000,
      })).resolves.toBe(true);
    } finally {
      await server.close();
    }
  });
});
