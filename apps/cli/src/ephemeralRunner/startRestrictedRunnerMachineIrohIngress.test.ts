import {
  IrohMachineHandshakeV1Schema,
  type FeaturesResponse,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';

import type { StartPeerMediationLoopbackInput, StartedPeerMediationLoopback } from '@/daemon/peer/mediation/rpc/startLoopback';

import { startRestrictedRunnerMachineIrohIngress } from './startRestrictedRunnerMachineIrohIngress';

const serverFeatures = {
  capabilities: {
    machines: {
      peerMediation: {
        grantSigningKeys: [],
      },
    },
  },
} as unknown as FeaturesResponse;

const finiteTransferHandshake = IrohMachineHandshakeV1Schema.parse({
  v: 1,
  accountId: 'account-1',
  initiator: {
    kind: 'machine',
    machineId: 'machine-source',
    endpointId: 'b'.repeat(64),
  },
  target: {
    machineId: 'machine-1',
    endpointId: 'a'.repeat(64),
  },
  flow: 'finite_transfer',
  grant: {
    payload: {
      v: 2,
      grantId: 'runner-test-grant',
      accountId: 'account-1',
      machineId: 'machine-1',
      flowKind: 'bounded_transfer',
      routeKind: 'iroh_peer',
      scope: { kind: 'bounded_transfer', mode: 'carrier' },
      iat: 1_000,
      exp: 10_000,
      aud: 'happier-daemon-route-grant',
      endpointFingerprint: 'a'.repeat(64),
      iroh: {
        initiator: {
          kind: 'machine',
          machineId: 'machine-source',
          endpointId: 'b'.repeat(64),
        },
        target: {
          machineId: 'machine-1',
          endpointId: 'a'.repeat(64),
        },
        operationKind: 'finite_transfer',
      },
      proofKind: 'ephemeral_ed25519',
      ephemeralPublicKeyBase64Url: 'A'.repeat(43),
    },
    signature: {
      keyId: 'runner-test-key',
      alg: 'Ed25519',
      valueBase64Url: 'A'.repeat(86),
    },
  },
  proof: {
    v: 2,
    kind: 'ephemeral_ed25519',
    signedGrantDigestBase64Url: 'A'.repeat(43),
    nonceBase64Url: 'A'.repeat(22),
    signatureBase64Url: 'A'.repeat(86),
  },
});

function createFixture() {
  const startAttemptAcceptor = vi.fn(async () => undefined);
  const stopAttemptAcceptor = vi.fn(async (): Promise<void> => undefined);
  const stopActiveTunnels = vi.fn(async (): Promise<void> => undefined);
  const loopbackStop = vi.fn(async (): Promise<void> => undefined);
  let loopbackInput: StartPeerMediationLoopbackInput | null = null;
  const startLoopback = vi.fn(async (input: StartPeerMediationLoopbackInput) => {
    loopbackInput = input;
    const endpoint: StartedPeerMediationLoopback['endpoint'] = {
      v: 1,
      routeKind: 'loopback_direct',
      url: 'http://127.0.0.1:47001',
      endpointFingerprint: 'pmrpc_fixture',
      expiresAt: Date.now() + 60_000,
    };
    return {
      endpoint,
      readEndpoint: () => endpoint,
      subscribeEndpointChanges: () => () => {},
      activeFlows: { machine_rpc: true as const },
      stop: loopbackStop,
    };
  });
  const invokeLocal = vi.fn(async (method: string) => ({ method }));
  return {
    startAttemptAcceptor,
    stopAttemptAcceptor,
    stopActiveTunnels,
    loopbackStop,
    startLoopback,
    invokeLocal,
    getLoopbackInput: () => {
      if (!loopbackInput) throw new Error('loopback_not_started');
      return loopbackInput;
    },
  };
}

describe('restricted Runner Machine Iroh ingress', () => {
  it('starts the classified loopback before the acceptor and routes only Protocol-classified RPC', async () => {
    const fixture = createFixture();
    const ensureDirectTransferListening = vi.fn(async () => 47_002);
    const started = await startRestrictedRunnerMachineIrohIngress({
      accountId: 'account-1',
      machineId: 'machine-1',
      serverFeatures,
      runtime: {
        endpoint: { endpointId: 'a'.repeat(64) },
        startAttemptAcceptor: fixture.startAttemptAcceptor,
        stopAttemptAcceptor: fixture.stopAttemptAcceptor,
        stopActiveTunnels: fixture.stopActiveTunnels,
      },
      rpcHandlerManager: { invokeLocal: fixture.invokeLocal },
      ensureDirectTransferListening,
      startLoopback: fixture.startLoopback,
    });

    expect(fixture.startLoopback.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.startAttemptAcceptor.mock.invocationCallOrder[0]!);
    expect(fixture.startAttemptAcceptor).toHaveBeenCalledWith({ admissionPort: 47_001 });

    const rpc = fixture.getLoopbackInput().rpcHandlerManager!;
    await expect(rpc.invokeLocal(RPC_METHODS.READ_FILE, { path: 'README.md' }))
      .resolves.toEqual({ method: RPC_METHODS.READ_FILE });
    await expect(rpc.invokeLocal('runner.unclassified', {})).resolves.toMatchObject({
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
    });
    expect(fixture.invokeLocal).toHaveBeenCalledTimes(1);

    const admission = fixture.getLoopbackInput().irohMachineAdmission!;
    await expect(admission.resolveApplicationTarget({
      handshake: finiteTransferHandshake,
      authenticatedRemoteEndpointId: 'b'.repeat(64),
      signal: new AbortController().signal,
    })).resolves.toEqual({ port: 47_002 });

    await started.stop();
    await started.stop();
    expect(fixture.stopActiveTunnels).toHaveBeenCalledOnce();
    expect(fixture.stopAttemptAcceptor).toHaveBeenCalledOnce();
    expect(fixture.loopbackStop).toHaveBeenCalledOnce();
  });

  it('unwinds the loopback and never returns an advertised-ready ingress when acceptor startup fails', async () => {
    const fixture = createFixture();
    fixture.startAttemptAcceptor.mockRejectedValueOnce(new Error('acceptor_failed'));

    await expect(startRestrictedRunnerMachineIrohIngress({
      accountId: 'account-1',
      machineId: 'machine-1',
      serverFeatures,
      runtime: {
        endpoint: { endpointId: 'a'.repeat(64) },
        startAttemptAcceptor: fixture.startAttemptAcceptor,
        stopAttemptAcceptor: fixture.stopAttemptAcceptor,
        stopActiveTunnels: fixture.stopActiveTunnels,
      },
      rpcHandlerManager: { invokeLocal: fixture.invokeLocal },
      ensureDirectTransferListening: async () => 47_002,
      startLoopback: fixture.startLoopback,
    })).rejects.toThrow('acceptor_failed');

    expect(fixture.loopbackStop).toHaveBeenCalledOnce();
    expect(fixture.stopActiveTunnels).toHaveBeenCalledOnce();
    expect(fixture.stopAttemptAcceptor).toHaveBeenCalledOnce();
  });

  it('fails direct RPC and finite-transfer admission closed as soon as stop begins', async () => {
    const fixture = createFixture();
    let releaseCleanup!: () => void;
    fixture.stopActiveTunnels.mockImplementationOnce(async () => await new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    }));
    const ensureDirectTransferListening = vi.fn(async () => 47_002);
    const started = await startRestrictedRunnerMachineIrohIngress({
      accountId: 'account-1',
      machineId: 'machine-1',
      serverFeatures,
      runtime: {
        endpoint: { endpointId: 'a'.repeat(64) },
        startAttemptAcceptor: fixture.startAttemptAcceptor,
        stopAttemptAcceptor: fixture.stopAttemptAcceptor,
        stopActiveTunnels: fixture.stopActiveTunnels,
      },
      rpcHandlerManager: { invokeLocal: fixture.invokeLocal },
      ensureDirectTransferListening,
      startLoopback: fixture.startLoopback,
    });

    const stopping = started.stop();
    const loopbackInput = fixture.getLoopbackInput();
    await expect(loopbackInput.rpcHandlerManager!.invokeLocal(RPC_METHODS.READ_FILE, {}))
      .resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    await expect(loopbackInput.irohMachineAdmission!.resolveApplicationTarget({
      handshake: finiteTransferHandshake,
      authenticatedRemoteEndpointId: 'b'.repeat(64),
      signal: new AbortController().signal,
    })).resolves.toBeNull();
    expect(fixture.invokeLocal).not.toHaveBeenCalled();
    expect(ensureDirectTransferListening).not.toHaveBeenCalled();

    releaseCleanup();
    await stopping;
  });
});
