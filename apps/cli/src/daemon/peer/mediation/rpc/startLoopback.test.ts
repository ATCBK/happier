import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  FeaturesResponseSchema,
  type FeaturesResponse,
  type PeerLoopbackEndpointCandidateV1,
} from '@happier-dev/protocol';

import {
  startPeerMediationLoopback,
  type StartPeerMediationLoopbackInput,
} from './startLoopback';
import { startPeerMediationLoopbackServer } from '../loopback/server';

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function createServerFeatures(publicKey: Uint8Array): FeaturesResponse {
  return FeaturesResponseSchema.parse({
    features: {
      machines: {
        enabled: true,
        rpc: {
          enabled: true,
          directPeer: { enabled: true },
        },
        tunnel: {
          enabled: true,
          directPeer: { enabled: true },
          serverRouted: { enabled: false },
        },
        liveStream: {
          enabled: true,
          directPeer: { enabled: true },
        },
      },
    },
    capabilities: {
      machines: {
        peerMediation: {
          grantSigningKeys: [{
            keyId: 'grant-key-1',
            publicKey: toBase64Url(publicKey),
            expiresAt: null,
          }],
        },
      },
    },
  });
}

describe('startPeerMediationLoopback', () => {
  it('renews a listening endpoint at its lease deadline without reads and withdraws before stop completes', async () => {
    let now = 2_000;
    const started = await startPeerMediationLoopback({
      accountId: 'account_1', machineId: 'machine_1',
      serverFeatures: createServerFeatures(tweetnacl.sign.keyPair().publicKey),
      rpcHandlerManager: { invokeLocal: async () => ({ ok: true }) },
      nowMs: () => now,
    });
    if (!started) throw new Error('expected listener');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const changes: (PeerLoopbackEndpointCandidateV1 | null)[] = [];
    try {
      const unsubscribe = started.subscribeEndpointChanges(() => changes.push(started.readEndpoint()));
      const initial = started.readEndpoint();
      if (!initial) throw new Error('expected endpoint');
      const ttl = initial.expiresAt - now;
      now += ttl / 2 - 1;
      await vi.advanceTimersByTimeAsync(ttl / 2 - 1);
      expect(started.readEndpoint()).toEqual(initial);
      expect(changes).toEqual([]);
      now += 1;
      expect(started.readEndpoint()).toEqual(initial);
      await vi.advanceTimersByTimeAsync(1);
      expect(changes).toEqual([{ ...initial, expiresAt: now + ttl }]);
      expect(started.readEndpoint()).toEqual({ ...initial, expiresAt: now + ttl });
      const stopping = started.stop();
      expect(started.readEndpoint()).toBeNull();
      expect(changes.at(-1)).toBeNull();
      await stopping;
      now += ttl;
      await vi.advanceTimersByTimeAsync(ttl);
      expect(started.readEndpoint()).toBeNull();
      expect(changes).toHaveLength(2);
      unsubscribe();
    } finally {
      await started.stop();
      vi.useRealTimers();
    }
  });

  it('publishes withdrawal immediately when its listener closes outside the stop handle', async () => {
    let now = 2_000;
    let closeListener: (() => Promise<void>) | undefined;
    const started = await startPeerMediationLoopback({
      accountId: 'account_1', machineId: 'machine_1',
      serverFeatures: createServerFeatures(tweetnacl.sign.keyPair().publicKey),
      rpcHandlerManager: { invokeLocal: async () => ({ ok: true }) },
      nowMs: () => now,
      startPeerMediationLoopbackServer: async (options) => {
        const listener = await startPeerMediationLoopbackServer(options);
        closeListener = listener.stop;
        return listener;
      },
    });
    if (!started || !closeListener) throw new Error('expected listener');
    const changes: (PeerLoopbackEndpointCandidateV1 | null)[] = [];
    const unsubscribe = started.subscribeEndpointChanges(() => changes.push(started.readEndpoint()));
    try {
      await closeListener();
      expect(changes).toEqual([null]);
      now = started.endpoint.expiresAt + 1;
      expect(started.readEndpoint()).toBeNull();
    } finally {
      unsubscribe();
      await started.stop();
    }
  });

  it('publishes the real listener base URL without a retired probe or Account signing material', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const started = await startPeerMediationLoopback({
      accountId: 'account_1', machineId: 'machine_1',
      serverFeatures: createServerFeatures(grantKeyPair.publicKey),
      rpcHandlerManager: { invokeLocal: async () => ({ ok: true }) },
      nowMs: () => 2_000,
    });
    expect(started).not.toBeNull();
    try {
      expect(new URL(started!.endpoint.url).pathname).toBe('/');
    } finally {
      await started?.stop();
    }
  });

  it('registers TCP and Voice flows with the same started tunnel endpoint authority', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    let capturedStartOptions: Parameters<NonNullable<
      StartPeerMediationLoopbackInput['startPeerMediationLoopbackServer']
    >>[0] | undefined;
    const startPeerMediationLoopbackServer: StartPeerMediationLoopbackInput['startPeerMediationLoopbackServer'] =
      vi.fn(async (options) => {
        capturedStartOptions = options;
        return {
          app: {} as never,
          url: 'http://127.0.0.1:47001',
          endpoint: {
            v: 1 as const,
            routeKind: 'loopback_direct' as const,
            url: 'http://127.0.0.1:47001',
            endpointFingerprint: options.expected.endpointFingerprint,
            expiresAt: options.endpointExpiresAt,
          },
          stop: async () => undefined,
        };
      });

    const started = await startPeerMediationLoopback({
      accountId: 'account_1',
      machineId: 'machine_1',
      serverFeatures: createServerFeatures(grantKeyPair.publicKey),
      tunnel: {},
      nowMs: () => 2_000,
      endpointFingerprint: () => 'endpoint_1',
      startPeerMediationLoopbackServer,
    });

    expect(started?.activeFlows.tcp_tunnel).toBe(true);
    if (!capturedStartOptions) throw new Error('expected loopback server startup options');
    const tcpExpected = capturedStartOptions.expectedByFlow?.tcp_tunnel;
    expect(tcpExpected).toEqual({
      accountId: 'account_1',
      machineId: 'machine_1',
      flowKind: 'tcp_tunnel',
      routeKind: 'loopback_direct',
      endpointFingerprint: 'endpoint_1',
    });
    expect(capturedStartOptions.expectedByFlow?.voice_media).toEqual({
      ...tcpExpected,
      flowKind: 'voice_media',
    });
  });

  it('starts the current verifier for keyless accounts without probing server proof versions', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const startPeerMediationLoopbackServer = vi.fn(async (options) => ({
      app: {} as never,
      url: 'http://127.0.0.1:47002',
      endpoint: {
        v: 1 as const,
        routeKind: 'loopback_direct' as const,
        url: 'http://127.0.0.1:47002',
        endpointFingerprint: options.expected.endpointFingerprint,
        expiresAt: options.endpointExpiresAt,
      },
      stop: async () => undefined,
    }));

    const started = await startPeerMediationLoopback({
      accountId: 'account_1',
      machineId: 'machine_1',
      serverFeatures: createServerFeatures(grantKeyPair.publicKey),
      rpcHandlerManager: { invokeLocal: async () => ({ ok: true }) },
      nowMs: () => 2_000,
      startPeerMediationLoopbackServer,
    });

    expect(started?.endpoint.endpointFingerprint).toEqual(expect.any(String));
    expect(startPeerMediationLoopbackServer).toHaveBeenCalledWith(expect.objectContaining({
      expected: expect.not.objectContaining({ accountPublicKey: expect.anything() }),
    }));
  });

  it('starts the shared loopback app for Iroh admission alone and forwards the admission owner unchanged', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const irohMachineAdmission = {
      localEndpointId: 'a'.repeat(64),
      role: 'acceptor' as const,
      allowedFlows: ['finite_transfer', 'workspace_sync'] as const,
      resolveApplicationTarget: vi.fn(async () => ({ port: 47321 })),
    };
    const startPeerMediationLoopbackServer = vi.fn(async (options) => ({
      app: {} as never,
      url: 'http://127.0.0.1:47002',
      endpoint: {
        v: 1 as const,
        routeKind: 'loopback_direct' as const,
        url: 'http://127.0.0.1:47002',
        endpointFingerprint: options.expected.endpointFingerprint,
        expiresAt: options.endpointExpiresAt,
      },
      stop: async () => undefined,
    }));

    const started = await startPeerMediationLoopback({
      accountId: 'account_1',
      machineId: 'machine_1',
      serverFeatures: createServerFeatures(grantKeyPair.publicKey),
      irohMachineAdmission,
      nowMs: () => 2_000,
      startPeerMediationLoopbackServer,
    });

    expect(started).not.toBeNull();
    expect(startPeerMediationLoopbackServer).toHaveBeenCalledWith(expect.objectContaining({
      irohMachineAdmission,
    }));
  });

  it('fails Iroh-only startup closed when the feature snapshot has no grant trust roots', async () => {
    const features = createServerFeatures(tweetnacl.sign.keyPair().publicKey);
    features.capabilities.machines.peerMediation.grantSigningKeys = [];
    const startPeerMediationLoopbackServer = vi.fn();
    await expect(startPeerMediationLoopback({
      accountId: 'account_1',
      machineId: 'machine_1',
      serverFeatures: features,
      irohMachineAdmission: {
        localEndpointId: 'a'.repeat(64),
        role: 'acceptor',
        allowedFlows: ['workspace_sync'],
        resolveApplicationTarget: async () => ({ port: 47321 }),
      },
      startPeerMediationLoopbackServer,
    })).resolves.toBeNull();
    expect(startPeerMediationLoopbackServer).not.toHaveBeenCalled();
  });

  it('generates a fresh endpoint fingerprint for each loopback lifetime', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const capturedFingerprints: string[] = [];
    const startPeerMediationLoopbackServer = vi.fn(async (options) => {
      capturedFingerprints.push(options.expected.endpointFingerprint);
      return {
        app: {} as never,
        url: 'http://127.0.0.1:47001',
        endpoint: {
          v: 1 as const,
          routeKind: 'loopback_direct' as const,
          url: 'http://127.0.0.1:47001',
          endpointFingerprint: options.expected.endpointFingerprint,
          expiresAt: options.endpointExpiresAt,
        },
        stop: async () => undefined,
      };
    });
    const input = {
      accountId: 'account_1',
      machineId: 'machine_1',
      serverFeatures: createServerFeatures(grantKeyPair.publicKey),
      rpcHandlerManager: { invokeLocal: async () => ({ ok: true }) },
      nowMs: () => 2_000,
      startPeerMediationLoopbackServer,
    } as const;

    await startPeerMediationLoopback(input);
    await startPeerMediationLoopback(input);

    expect(capturedFingerprints).toHaveLength(2);
    expect(capturedFingerprints[0]).not.toBe(capturedFingerprints[1]);
  });

  it('does not register direct live-stream routes on the production loopback listener without a capture adapter', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const endpoint: PeerLoopbackEndpointCandidateV1 = {
      v: 1,
      routeKind: 'loopback_direct',
      url: 'http://127.0.0.1:47001',
      endpointFingerprint: 'endpoint_1',
      expiresAt: 302_000,
    };
    const captured: { startOptions?: Parameters<NonNullable<
      StartPeerMediationLoopbackInput['startPeerMediationLoopbackServer']
    >>[0] } = {};
    const startPeerMediationLoopbackServer: StartPeerMediationLoopbackInput['startPeerMediationLoopbackServer'] =
      vi.fn(async (options) => {
        captured.startOptions = options;
        return {
          app: {} as never,
          url: endpoint.url,
          endpoint,
          stop: async () => undefined,
        };
      });

    const started = await startPeerMediationLoopback({
      accountId: 'account_1',
      machineId: 'machine_1',
      serverFeatures: createServerFeatures(grantKeyPair.publicKey),
      rpcHandlerManager: {
        invokeLocal: async () => ({ ok: true }),
      },
      nowMs: () => 2_000,
      endpointFingerprint: () => 'endpoint_1',
      startPeerMediationLoopbackServer,
    });

    expect(started?.endpoint).toEqual(endpoint);
    if (!captured.startOptions) throw new Error('expected loopback server startup options');
    const capturedStartOptions = captured.startOptions;
    expect(capturedStartOptions).toEqual(expect.objectContaining({
      expected: expect.objectContaining({
        flowKind: 'machine_rpc',
        endpointFingerprint: 'endpoint_1',
      }),
    }));
    expect(capturedStartOptions.expectedByFlow).not.toHaveProperty('live_stream');
    expect(capturedStartOptions).not.toHaveProperty('stream');
  });
});
