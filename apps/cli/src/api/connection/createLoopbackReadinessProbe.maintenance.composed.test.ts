import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createManagedConnectionSupervisor,
  DEFAULT_MANAGED_CONNECTION_POLICY,
  type ManagedConnectionTransport,
} from '@happier-dev/connection-supervisor';

import { createLoopbackReadinessProbe } from './createLoopbackReadinessProbe';

// Real supervisor + real readiness probe + a real HTTP listener standing in for the Home behind a dev proxy
// or load balancer. Only the socket transport is faked, because it is the one boundary that needs a live server.
function createFakeSocketTransport() {
  const connected = new Set<() => void>();
  const disconnected = new Set<(event: { intentional?: boolean }) => void>();
  let isConnected = false;
  const transport: ManagedConnectionTransport = {
    async connect() {
      isConnected = true;
      for (const listener of connected) listener();
    },
    async disconnect(params) {
      isConnected = false;
      for (const listener of disconnected) listener({ intentional: params?.intentional === true });
    },
    async destroy() {
      isConnected = false;
    },
    isConnected: () => isConnected,
    onConnected: (listener) => { connected.add(listener); return () => connected.delete(listener); },
    onDisconnected: (listener) => { disconnected.add(listener); return () => disconnected.delete(listener); },
    onError: () => () => undefined,
  };
  return {
    transport,
    drop() {
      isConnected = false;
      for (const listener of disconnected) listener({});
    },
  };
}

describe('maintenance window on the reconnect path', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = null;
  });

  it('reconnects at the announced Retry-After after maintenance, not on the exponential ladder', async () => {
    let maintenance = true;
    let probeRequests = 0;
    server = createServer((request, response) => {
      if (request.url === '/v1/features') probeRequests += 1;
      if (maintenance) {
        response.writeHead(503, { 'Retry-After': '1', 'X-Happier-Retry-Reason': 'server_restarting' });
        response.end('Server reload in progress');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(request.url === '/v1/features'
        ? JSON.stringify({ features: {}, capabilities: { serverIdentity: {} } })
        : '{}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const transports: Array<ReturnType<typeof createFakeSocketTransport>> = [];
    let reconnectedAt: number | null = null;
    const supervisor = createManagedConnectionSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      jitterRatio: 0,
      createTransport: () => {
        const next = createFakeSocketTransport();
        transports.push(next);
        return next.transport;
      },
      probeReadiness: createLoopbackReadinessProbe({ serverUrl, token: 'account-token' }),
      onConnected: () => {
        if (transports.length > 1) reconnectedAt = Date.now();
      },
    });
    await supervisor.start();
    try {
      transports[0]!.drop();
      // The first probe (250 ms fast retry) lands in maintenance; the Home becomes ready just after it.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(probeRequests).toBe(1);
      maintenance = false;
      const readyAt = Date.now();

      await expect.poll(() => reconnectedAt, { timeout: 5_000, interval: 25 }).not.toBeNull();
      // Announced wait: ~1 s after the first probe, so ~0.85 s after ready. The old ladder retried at ~2.25 s, ~1.85 s after ready.
      expect(reconnectedAt! - readyAt).toBeLessThan(1_400);
      expect(supervisor.getState().phase).toBe('online');
    } finally {
      await supervisor.stop();
    }
  }, 15_000);
});
