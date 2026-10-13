import { describe, expect, it } from 'vitest';

import {
  DoctorSnapshotHomeTransportDiagnosticsSchema,
  DoctorSnapshotSchema,
  parseDoctorSnapshotSafe,
  sanitizeDoctorDiagnosticText,
} from './doctorSnapshot.js';

describe('DoctorSnapshotSchema', () => {
  it('preserves the latest daemon resource facts in the exported Doctor snapshot', () => {
    const memory = process.memoryUsage();
    const resourceVitals = { sample: null, attention: null, self: { sampledAt: Date.now(),
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
      eventLoopBusyFraction: null, activeHandleCount: null, unavailableReason: 'runtime_not_reported' } };
    const snapshot = DoctorSnapshotSchema.parse({ capturedAt: new Date().toISOString(), accountId: null,
      server: { activeServerId: 'local', serverUrl: 'http://localhost', publicServerUrl: 'http://localhost', webappUrl: 'http://localhost' },
      settings: { activeServerId: 'local', servers: [], knownAccountIds: [] }, resourceVitals });
    expect(snapshot).toHaveProperty('resourceVitals', resourceVitals);
  });
  it('sanitizes a multiline copied diagnostic while preserving non-secret technical detail', () => {
    const sanitized = sanitizeDoctorDiagnosticText([
      'transport: connection refused on relay eu-west-1',
      'Authorization: Bearer bearer-value',
      'password:',
      'multiline-password',
      'url: https://alice:url-password@relay.example.test/path?token=query-secret#proof',
      'proof=proof-value api_key=key-value clientSecret=client-secret',
    ].join('\n'));

    expect(sanitized).toContain('connection refused on relay eu-west-1');
    expect(sanitized).toContain('Authorization=[redacted]');
    expect(sanitized).toContain('password=[redacted]');
    expect(sanitized).toContain('https://relay.example.test/path');
    for (const secret of [
      'bearer-value', 'multiline-password', 'alice', 'url-password', 'query-secret',
      'proof-value', 'key-value', 'client-secret',
    ]) {
      expect(sanitized).not.toContain(secret);
    }
  });

  it('parses truthful Home transport diagnostics without requiring unobserved carrier or path facts', () => {
    const parsed = DoctorSnapshotHomeTransportDiagnosticsSchema.parse({
      homeServerIdentityId: 'home_1',
      state: 'reconnecting',
      effectiveConfiguration: {
        policy: 'automatic',
        relayUrls: ['https://relay.example.test/'],
        directAddressCount: 2,
      },
      lastKnown: {
        carrier: 'iroh',
        observedPath: 'relay',
      },
      lastTransitionAtMs: 1_788_200_000_000,
      diagnosticError: {
        code: 'transport_closed',
        atMs: 1_788_200_000_000,
      },
    });

    expect(parsed).toMatchObject({
      state: 'reconnecting',
      effectiveConfiguration: { policy: 'automatic', directAddressCount: 2 },
      lastKnown: { carrier: 'iroh', observedPath: 'relay' },
      diagnosticError: { code: 'transport_closed' },
    });
    expect(parsed.current).toBeUndefined();
  });

  it('accepts a valid snapshot and parseDoctorSnapshotSafe redacts userinfo/query/hash', () => {
    const raw = JSON.stringify({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
        publicServerUrl: 'https://api.happier.dev/path?token=abc',
        webappUrl: 'https://app.happier.dev/?token=abc',
      },
      accountId: 'acct_123',
      settings: {
        activeServerId: 'cloud',
        servers: [
          {
            id: 'cloud',
            name: 'Happier Cloud',
            serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc',
            webappUrl: 'https://app.happier.dev/?token=abc',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        ],
        knownAccountIds: ['acct_123'],
      },
      homeTransports: [{
        homeServerIdentityId: 'home_1',
        state: 'connected',
        effectiveConfiguration: {
          policy: 'automatic',
          relayUrls: ['https://relay-user:relay-secret@relay.example.test/path?token=abc#frag'],
          directAddressCount: 1,
        },
        current: { carrier: 'iroh', observedPath: 'relay' },
        diagnosticError: {
          code: 'transport_closed token=top-secret\u0000',
          message: 'Relay failed at https://relay-user:relay-secret@relay.example.test/path?token=abc token=top-secret',
          atMs: 1_788_200_000_000,
        },
      }],
      daemonStatus: {
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
          localServerUrl: 'http://127.0.0.1:3005/?token=abc',
          publicServerUrl: 'https://api.happier.dev/path?token=abc',
          webappUrl: 'https://app.happier.dev/?token=abc',
          comparableKey: 'https://api.happier.dev',
        },
        daemon: {
          running: true,
          pid: 4321,
          httpPort: null,
          startedWithCliVersion: '1.2.3',
          startedWithPublicReleaseChannel: 'preview',
          startupSource: 'background-service',
          serviceManaged: true,
          serviceLabel: 'com.happier.cli.daemon.default',
        },
        service: {
          installed: true,
          running: true,
        },
        auth: {
          authenticated: true,
          credentialState: 'valid',
          machineRegistered: false,
          machineRegistrationState: 'no-local-id',
          machineId: null,
          needsAuth: true,
          accountId: 'acct_123',
        },
      },
      installations: {
        happier: {
          activeInvocation: {
            path: '/Users/tester/.happier/bin/hprev',
            realPath: '/Users/tester/.happier/cli-preview/current/happier',
            invokerName: 'hprev',
            ring: 'preview',
            version: '1.2.3-preview.4',
            installationId: 'managed:preview:/Users/tester/.happier/cli-preview/current',
          },
          installations: [
            {
              id: 'managed:preview:/Users/tester/.happier/cli-preview/current',
              source: 'firstPartyManaged',
              components: ['happier-cli', 'happier-daemon'],
              ring: 'preview',
              version: '1.2.3-preview.4',
              path: '/Users/tester/.happier/cli-preview/current',
              realPath: '/Users/tester/.happier/cli-preview/current',
              shimName: 'hprev',
              onPath: true,
              managedRoot: '/Users/tester/.happier/cli-preview',
            },
          ],
        },
      },
      services: {
        happier: {
          services: [
            {
              id: 'launchd:preview:cloud',
              serviceType: 'daemon',
              platform: 'darwin',
              backend: 'launchd',
              label: 'com.happier.cli.daemon.preview.cloud',
              verification: 'verified',
              ring: 'preview',
              instanceId: 'cloud',
              scope: 'user',
              definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.cloud.plist',
              executablePath: '/Users/tester/.happier/cli-preview/current/happier',
              serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
              publicServerUrl: 'https://api.happier.dev/path?token=abc',
              installed: true,
              running: true,
            },
          ],
        },
      },
      warnings: [
        {
          code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
          severity: 'warning',
          message: 'Multiple Happier CLI installations were detected on PATH.',
          repairCommands: ['happier doctor --json'],
        },
      ],
    });

    const parsed = parseDoctorSnapshotSafe(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');

    expect(DoctorSnapshotSchema.safeParse(parsed.snapshot).success).toBe(true);
    const serialized = JSON.stringify(parsed.snapshot);
    expect(serialized).not.toContain('admin:secret');
    expect(serialized).not.toContain('?token=');
    expect(serialized).not.toContain('#frag');
    expect(parsed.snapshot.daemonStatus?.server.localServerUrl).toBe('http://127.0.0.1:3005');
    expect(parsed.snapshot.daemonStatus?.daemon.startedWithCliVersion).toBe('1.2.3');
    expect(parsed.snapshot.daemonStatus?.daemon.startedWithPublicReleaseChannel).toBe('preview');
    expect(parsed.snapshot.daemonStatus?.daemon.startupSource).toBe('background-service');
    expect(parsed.snapshot.daemonStatus?.daemon.serviceManaged).toBe(true);
    expect(parsed.snapshot.daemonStatus?.daemon.serviceLabel).toBe('com.happier.cli.daemon.default');
    expect(parsed.snapshot.daemonStatus?.auth.credentialState).toBe('valid');
    expect(parsed.snapshot.daemonStatus?.auth.machineRegistrationState).toBe('no-local-id');
    expect(parsed.snapshot.homeTransports?.[0]?.effectiveConfiguration?.relayUrls).toEqual([
      'https://relay.example.test/path',
    ]);
    expect(parsed.snapshot.homeTransports?.[0]?.diagnosticError).toMatchObject({
      code: 'transport_closed token=[redacted]',
      message: 'Relay failed at https://relay.example.test/path token=[redacted]',
    });
    expect(parsed.snapshot.installations?.happier.installations[0]?.ring).toBe('preview');
    expect(parsed.snapshot.services?.happier.services[0]?.label).toContain('com.happier.cli.daemon.preview.cloud');
    expect(parsed.snapshot.services?.happier.services[0]?.serverUrl).toBe('https://api.happier.dev/path');
    expect(parsed.snapshot.services?.happier.services[0]?.publicServerUrl).toBe('https://api.happier.dev/path');
    expect(parsed.snapshot.warnings?.[0]?.code).toBe('MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH');
  });

  it('parseDoctorSnapshotSafe removes complete Authorization Bearer/Basic credentials from transport diagnostics', () => {
    const bearerSecret = 'sk-live-9f2c61ab47e0';
    const basicSecret = 'dXNlcjpwYXNzd29yZA==';
    const raw = JSON.stringify({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://api.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
      accountId: null,
      settings: { activeServerId: null, servers: [], knownAccountIds: [] },
      homeTransports: [
        {
          homeServerIdentityId: 'home_leak',
          state: 'unavailable',
          diagnosticError: {
            code: `transport_closed Authorization: Bearer ${bearerSecret}`,
            message: `Home rejected authorization=Basic ${basicSecret}; retry scheduled`,
            atMs: 1_788_200_000_000,
          },
        },
      ],
    });

    const parsed = parseDoctorSnapshotSafe(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');

    // The credential after the auth scheme is the secret; redacting only the scheme word
    // would publish it. The scheme word itself is not a secret and may survive.
    expect(parsed.snapshot.homeTransports?.[0]?.diagnosticError).toMatchObject({
      code: 'transport_closed Authorization=[redacted]',
      message: 'Home rejected authorization=[redacted]; retry scheduled',
    });
    const serialized = JSON.stringify(parsed.snapshot);
    expect(serialized).not.toContain(bearerSecret);
    expect(serialized).not.toContain(basicSecret);
    expect(serialized).toContain('retry scheduled');
  });

  it('parseDoctorSnapshotSafe removes standalone bearer-shaped tokens from transport diagnostics', () => {
    const bearerToken =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJob21lX2xlYWt9.tL2V4kQGz6rRkM8B1eBqFjJZuC9pXwYy3nSaH0cVdZk';
    const raw = JSON.stringify({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://api.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
      accountId: null,
      settings: { activeServerId: null, servers: [], knownAccountIds: [] },
      homeTransports: [
        {
          homeServerIdentityId: 'home_leak',
          state: 'reconnecting',
          diagnosticError: {
            code: 'transport_closed',
            message: `Handshake aborted while sending Bearer ${bearerToken} to the relay`,
            atMs: 1_788_200_000_000,
          },
        },
      ],
    });

    const parsed = parseDoctorSnapshotSafe(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');

    expect(parsed.snapshot.homeTransports?.[0]?.diagnosticError).toMatchObject({
      code: 'transport_closed',
      message: 'Handshake aborted while sending Bearer [redacted] to the relay',
    });
    expect(JSON.stringify(parsed.snapshot)).not.toContain(bearerToken);
  });

  it('parseDoctorSnapshotSafe removes common compound credential keys from plain and JSON-like transport diagnostics', () => {
    const secrets = [
      'access-secret',
      'refresh-secret',
      'api-secret',
      'auth-secret',
      'client-secret',
      'quoted-access-secret',
      'quoted-authorization-secret',
    ];
    const raw = JSON.stringify({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://api.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
      accountId: null,
      settings: { activeServerId: null, servers: [], knownAccountIds: [] },
      homeTransports: [{
        homeServerIdentityId: 'home_compound_keys',
        state: 'unavailable',
        diagnosticError: {
          code: `access_token=${secrets[0]} "access_token": "${secrets[5]}"`,
          message: `refresh-token:${secrets[1]}; api_key=${secrets[2]}, authToken=${secrets[3]} clientSecret=${secrets[4]} "Authorization": "Bearer ${secrets[6]}"`,
          atMs: 1_788_200_000_000,
        },
      }],
    });

    const parsed = parseDoctorSnapshotSafe(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    const serialized = JSON.stringify(parsed.snapshot);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(parsed.snapshot.homeTransports?.[0]?.diagnosticError).toMatchObject({
      code: 'access_token=[redacted] access_token=[redacted]',
      message: 'refresh-token=[redacted]; api_key=[redacted], authToken=[redacted] clientSecret=[redacted] Authorization=[redacted]',
    });
  });

  it('parseDoctorSnapshotSafe keeps ordinary nonsecret diagnostic text intact', () => {
    const raw = JSON.stringify({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://api.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
      accountId: null,
      settings: { activeServerId: null, servers: [], knownAccountIds: [] },
      homeTransports: [
        {
          homeServerIdentityId: 'home_plain',
          state: 'reconnecting',
          diagnosticError: {
            code: 'transport_closed',
            message: 'Relay connect failed: authorization required by Home; retry scheduled',
            atMs: 1_788_200_000_000,
          },
        },
      ],
    });

    const parsed = parseDoctorSnapshotSafe(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');

    expect(parsed.snapshot.homeTransports?.[0]?.diagnosticError).toEqual({
      code: 'transport_closed',
      message: 'Relay connect failed: authorization required by Home; retry scheduled',
      atMs: 1_788_200_000_000,
    });
  });

  it('preserves every Home transport entry instead of rejecting an arbitrary Home count', () => {
    const raw = JSON.stringify({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://api.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
      accountId: null,
      settings: { activeServerId: null, servers: [], knownAccountIds: [] },
      homeTransports: Array.from({ length: 70 }, (_, index) => ({
        homeServerIdentityId: `home_${index}`,
        state: 'disconnected',
        lastKnown: { carrier: 'iroh', observedPath: 'relay' },
        lastTransitionAtMs: index,
      })),
    });

    const parsed = parseDoctorSnapshotSafe(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.snapshot.homeTransports).toHaveLength(70);
  });

  it('returns a stable error for invalid JSON', () => {
    const parsed = parseDoctorSnapshotSafe('{not json}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected error');
    expect(parsed.error).toMatch(/invalid json/i);
  });

  it('accepts partial installations and services containers for forward compatibility', () => {
    const result = DoctorSnapshotSchema.safeParse({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://api.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
      accountId: null,
      settings: {
        activeServerId: null,
        servers: [],
        knownAccountIds: [],
      },
      installations: {},
      services: {},
    });

    expect(result.success).toBe(true);
  });

  // `healthy` answers "does this daemon work", separately from `running`, which only answers
  // "does a process exist". The daemon snapshot is validated through this schema before it is
  // written, so an undeclared field would be stripped in silence and `happier doctor` would go
  // on reporting a PID probe as health.
  it('carries the daemon service-health verdict and its explicit unknown', () => {
    const parseDaemonHealth = (healthy: boolean | null | undefined) => {
      const result = DoctorSnapshotSchema.safeParse({
        capturedAt: '2026-02-23T00:00:00.000Z',
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://api.happier.dev',
          publicServerUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
        },
        accountId: null,
        settings: { activeServerId: null, servers: [], knownAccountIds: [] },
        daemonStatus: {
          server: {
            activeServerId: 'cloud',
            serverUrl: 'https://api.happier.dev',
            localServerUrl: null,
            publicServerUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
            comparableKey: 'https://api.happier.dev',
          },
          daemon: {
            running: true,
            ...(healthy === undefined ? {} : { healthy }),
            pid: 4321,
            httpPort: null,
          },
          service: { installed: true, running: true },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine_1',
            needsAuth: false,
            accountId: null,
          },
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected a valid snapshot');
      return result.data.daemonStatus?.daemon;
    };

    // A live process whose machine-control registration never completed.
    expect(parseDaemonHealth(false)).toMatchObject({ running: true, healthy: false });
    expect(parseDaemonHealth(true)).toMatchObject({ running: true, healthy: true });
    // Explicitly inconclusive, and distinct from unhealthy.
    expect(parseDaemonHealth(null)).toMatchObject({ running: true, healthy: null });
    // A snapshot from a CLI that predates the field still parses, and reads as unknown.
    const older = parseDaemonHealth(undefined);
    expect(older).toMatchObject({ running: true });
    expect(older?.healthy ?? null).toBeNull();
  });

  it('preserves optional repair and local runtime diagnostic sections', () => {
    const result = DoctorSnapshotSchema.safeParse({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://api.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
      accountId: null,
      settings: {
        activeServerId: null,
        servers: [],
        knownAccountIds: [],
      },
      repairSummary: {
        schemaVersion: 1,
        status: 'needs_attention',
        findingCounts: {
          total: 3,
          warning: 2,
          error: 1,
          actionable: 2,
        },
        findingKinds: ['background_service_not_running', 'local_relay_stale'],
      },
      localRelays: {
        relays: [
          {
            id: 'local-relay-preview',
            releaseChannel: 'preview',
            relayUrl: 'http://127.0.0.1:3025/?token=secret#frag',
            version: '1.2.3-preview.1',
            installed: true,
            running: true,
            healthy: true,
            serviceEnabled: true,
            port: 3025,
            installRoot: '/Users/tester/.happier/relay-preview',
          },
        ],
      },
      automaticStartup: {
        entries: [
          {
            id: 'launchd:preview:default',
            label: 'com.happier.cli.daemon.preview.default',
            releaseChannel: 'preview',
            targetMode: 'default-following',
            scope: 'user',
            installed: true,
            running: false,
            definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.default.plist',
            relayUrl: 'https://admin:secret@relay.example.test/path?token=abc#frag',
          },
        ],
        defaultFollowingCount: 1,
        pinnedCount: 0,
      },
      activeStack: {
        activeServerId: 'cloud',
        releaseChannel: 'preview',
        relayUrl: 'https://relay.example.test/path?token=abc',
        localRelayUrl: 'http://127.0.0.1:3025/?token=abc',
        source: 'settings',
      },
      serviceHealth: {
        backgroundService: {
          installed: true,
          running: false,
          healthy: false,
          serviceLabel: 'com.happier.cli.daemon.preview.default',
          releaseChannel: 'preview',
          relayUrl: 'https://relay.example.test/path?token=abc',
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected optional diagnostic sections to parse');

    const parsed = parseDoctorSnapshotSafe(JSON.stringify(result.data));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected parsed optional diagnostic sections');

    expect(parsed.snapshot).toMatchObject({
      repairSummary: {
        status: 'needs_attention',
        findingCounts: {
          total: 3,
          warning: 2,
          error: 1,
          actionable: 2,
        },
        findingKinds: ['background_service_not_running', 'local_relay_stale'],
      },
      localRelays: {
        relays: [
          expect.objectContaining({
            releaseChannel: 'preview',
            relayUrl: 'http://127.0.0.1:3025',
            healthy: true,
          }),
        ],
      },
      automaticStartup: {
        entries: [
          expect.objectContaining({
            targetMode: 'default-following',
            relayUrl: 'https://relay.example.test/path',
          }),
        ],
      },
      activeStack: {
        relayUrl: 'https://relay.example.test/path',
        localRelayUrl: 'http://127.0.0.1:3025',
      },
      serviceHealth: {
        backgroundService: expect.objectContaining({
          running: false,
          relayUrl: 'https://relay.example.test/path',
        }),
      },
    });
  });
});
