import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '@/api/api';
import { reloadConfiguration } from '@/configuration';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { startDaemonMachineRegistrationRuntime } from './startDaemonMachineRegistrationRuntime';

describe('machine registration published Home readiness', () => {
  afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

  it('wakes registration through the reachable publication when the configured address is unreachable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-registration-endpoint-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:1');
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', '');
    vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', 'published-home');
    reloadConfiguration();
    let shutdownRequested = false;
    let shutdown: () => void = () => undefined;
    const resolvesWhenShutdownRequested = new Promise<void>(resolve => { shutdown = resolve; });
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? '');
      if (request.url === '/v1/features') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ features: {}, capabilities: {} }));
      } else if (request.url === '/v1/auth/ping') {
        response.end('{}');
        shutdownRequested = true;
        shutdown();
      } else {
        // A real interrupted Account request arms the production readiness wake source.
        request.socket.destroy();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
    const release = publishServerHttpRuntimeOrigin(`http://127.0.0.1:${address.port}`, 'iroh');
    try {
      const api = await ApiClient.create({ token: 'test-account-token' });
      startDaemonMachineRegistrationRuntime({
        api, credentials: { token: 'test-account-token' },
        metadataForRegistration: { host: 'host', platform: 'linux', happyCliVersion: 'test',
          homeDir: home, happyHomeDir: home, happyLibDir: home },
        initialDaemonState: { status: 'running' }, processEnv: {},
        resolvePositiveIntEnv: (_raw, fallback) => fallback,
        resolvesWhenShutdownRequested, initialPreflightMachineRegistration: null,
        resolveMachineId: () => 'machine-test', setMachineId: () => undefined,
        isShuttingDown: () => shutdownRequested,
        // Registration cannot reach bootstrap: shutdown is requested by the authenticated probe.
        bootstrapRuntime: {} as Parameters<typeof startDaemonMachineRegistrationRuntime>[0]['bootstrapRuntime'],
        onMachineSyncRuntime: () => undefined, filesystemAccessPolicy: { kind: 'osUser' },
        takeoverRequested: false, preferredHost: 'host',
        connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
      });
      await vi.waitFor(() => expect(paths).toContain('/v1/auth/ping'));
      expect(paths).toContain('/v1/features');
    } finally {
      shutdownRequested = true;
      shutdown();
      await new Promise<void>(resolve => setImmediate(resolve));
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
});
