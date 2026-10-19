import { describe, expect, it } from 'vitest';

import { DaemonStateSchema } from './types';

describe('DaemonStateSchema', () => {
  it('preserves the current daemon pending-session activation capability', () => {
    expect(DaemonStateSchema.parse({
      status: 'running',
      daemonPendingSessionActivationSupported: true,
    }).daemonPendingSessionActivationSupported).toBe(true);
  });

  it('publishes the declared Iroh machine endpoint and rejects undeclared peer fields', () => {
    const endpoint = { endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test/'] };
    const result = DaemonStateSchema.parse({
      status: 'running',
      peerMediation: { iroh: { endpoint } },
    });
    expect(result.peerMediation?.iroh?.endpoint).toEqual(endpoint);
    expect(DaemonStateSchema.safeParse({
      ...result,
      peerMediation: { iroh: { endpoint, futureField: true } },
    }).success).toBe(false);
  });

  it('publishes supported transfer runtime capabilities and rejects undeclared listener classes', () => {
    const result = DaemonStateSchema.safeParse({
      status: 'running',
      pid: 12345,
      httpPort: 43210,
      startedAt: 1_700_000_000_000,
      runtimeId: 'runtime-123',
      cliVersion: '0.2.0',
      publicReleaseChannel: 'dev',
      startupSource: 'background-service',
      serviceManaged: true,
      serviceLabel: 'com.happier.cli.daemon.default',
      transfer: {
        supported: {
          import: false,
          export: true,
        },
        listenerClasses: {
          loopback_http: {
            enabled: true,
            configured: true,
            active: false,
          },
          tailscale_serve_https: {
            enabled: false,
            configured: false,
            active: false,
            available: false,
          },
        },
        lifecycle: {
          mode: 'lazy_idle_shutdown',
          version: 1,
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw result.error;
    }

    expect(result.data.transfer).toEqual({
      supported: {
        import: false,
        export: true,
      },
      listenerClasses: {
        loopback_http: {
          enabled: true,
          configured: true,
          active: false,
        },
        tailscale_serve_https: {
          enabled: false,
          configured: false,
          active: false,
          available: false,
        },
      },
      lifecycle: {
        mode: 'lazy_idle_shutdown',
        version: 1,
      },
    });
    expect(result.data.runtimeId).toBe('runtime-123');
    expect(result.data.cliVersion).toBe('0.2.0');
    expect(result.data.publicReleaseChannel).toBe('dev');
    expect(result.data.startupSource).toBe('background-service');
    expect(result.data.serviceManaged).toBe(true);
    expect(result.data.serviceLabel).toBe('com.happier.cli.daemon.default');
    expect(DaemonStateSchema.safeParse({
      ...result.data,
      transfer: {
        ...result.data.transfer,
        listenerClasses: {
          ...result.data.transfer?.listenerClasses,
          lan_http: { enabled: false, configured: false, active: false },
        },
      },
    }).success).toBe(false);
  });
});
