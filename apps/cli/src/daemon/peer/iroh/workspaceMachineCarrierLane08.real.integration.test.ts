import { createDirectRouteGrantSigningInputV2, computeWorkspaceSyncPolicyDigest, type DirectRouteGrantRequestV2 } from '@happier-dev/protocol';
import { parseProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { createIrohNodeNativeModule, loadIrohNodeNativeAddon } from '@happier-dev/iroh-native/node';
import { createIrohTestControllerFromNativeAddon } from '@happier-dev/iroh-native/test-controller';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { startPeerMediationLoopbackServer } from '../mediation/loopback/server';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { connectWorkspaceSyncMachineTunnel } from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import { createWorkspaceSyncTargetAuthority } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { createDaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import { createWorkspaceMachineCarrierTunnelOpen } from './workspaceMachineCarrierTunnelOpen';

const accountId = 'account-composed-machine-workspace';
const sourceMachineId = 'machine-source';
const targetMachineId = 'machine-target';
const operationId = 'copy-once-native-operation';
const sourceWorkspaceRefId = 'workspace-source';
const targetWorkspaceRefId = 'workspace-target';
const nowMs = 2_000;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function projectSnapshot(sourceRoot: string, targetRoot: string): ActiveProjectAccountRowsSnapshot {
  const policyInput = {
    v: 1 as const,
    selection: 'all_files' as const,
    extraIgnorePatterns: [],
    extraIncludePatterns: [],
  };
  const contentPolicy = {
    ...policyInput,
    policyDigest: computeWorkspaceSyncPolicyDigest(policyInput),
  };
  return {
    source: 'network',
    ...parseProjectAccountSnapshotV1({
      workspaceRefs: [
        { id: sourceWorkspaceRefId, serverId: 'server-1', machineId: sourceMachineId, rootPath: sourceRoot, createdAtMs: 1 },
        { id: targetWorkspaceRefId, serverId: 'server-1', machineId: targetMachineId, rootPath: targetRoot, createdAtMs: 1 },
      ],
      relationships: [],
    }),
    organizations: [], rows: [], graphRevision: 1,
    loadedAtMs: 1,
    scopeKey: accountId,
  };
}

function createGrantMint(
  signingSecretKey: Uint8Array,
  options: Readonly<{ corruptSignature?: boolean }> = {},
) {
  return async (request: DirectRouteGrantRequestV2) => {
    const { kind, ttlMs: _ttlMs, ...binding } = request;
    const payload = {
      ...binding,
      grantId: `grant-${options.corruptSignature ? 'invalid' : 'valid'}`,
      accountId,
      iat: 1_000,
      exp: 301_000,
      aud: 'happier-daemon-route-grant' as const,
      proofKind: kind,
    };
    const signature = tweetnacl.sign.detached(
      Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
      signingSecretKey,
    );
    if (options.corruptSignature) signature[0] ^= 0xff;
    return {
      payload,
      signature: {
        keyId: 'composed-signing-key',
        alg: 'Ed25519' as const,
        valueBase64Url: base64url(signature),
      },
    };
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('production workspace opener -> native machine/1 -> Lane 08 ingress', () => {
  it.each([
    { topology: 'direct' as const, expectedPath: 'direct' as const },
    { topology: 'relay' as const, expectedPath: 'relay' as const },
  ])('moves exact nonzero duplex bytes over $topology and rejects an invalid signed grant without a fallback stream', async ({ topology, expectedPath }) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-machine-workspace-composed-'));
    const sourceHome = join(fixtureRoot, 'source-home');
    const targetHome = join(fixtureRoot, 'target-home');
    const sourceRoot = join(fixtureRoot, 'source-workspace');
    const targetRoot = join(fixtureRoot, 'target-workspace');
    const materializationDirectory = join(targetHome, 'daemon', 'workspace-sync', 'bootstrap');
    const lockDirectory = join(targetHome, 'daemon', 'workspace-sync', 'root-ownership');
    await Promise.all([
      mkdir(sourceHome, { recursive: true }),
      mkdir(targetHome, { recursive: true }),
      mkdir(sourceRoot, { recursive: true }),
      mkdir(targetRoot, { recursive: true }),
    ]);

    const addonPath = process.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH?.trim();
    if (!addonPath) throw new Error('The composed machine fixture requires an explicit test-feature addon path');
    const rawAddon = loadIrohNodeNativeAddon(addonPath);
    const testController = createIrohTestControllerFromNativeAddon(rawAddon);
    if (topology === 'direct') await testController.forceDirectOnly();
    else await testController.forceRelayOnly();
    expect(testController.getObservedPath()).toBe('unknown');
    const native = createIrohNodeNativeModule(rawAddon);
    const nativeStartMachineTunnel = vi.spyOn(native, 'startMachineTunnel');
    const nativeStartMachineAcceptor = vi.spyOn(native, 'startMachineAcceptor');
    const signingKeyPair = tweetnacl.sign.keyPair();
    const trustRoots = [{ keyId: 'composed-signing-key', publicKey: base64url(signingKeyPair.publicKey) }];
    const rootedAgents: PassThrough[] = [];
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory });
    const snapshot = projectSnapshot(sourceRoot, targetRoot);
    const callMachineRpc = vi.fn(async () => { throw new Error('Composed target ingress must remain local'); });
    let targetIngressFailure: string | null = null;
    const targetAuthority = createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: targetMachineId,
      getProjectSnapshot: () => snapshot,
      callMachineRpc,
      bootstrap: { materializationDirectory, rootOwnershipManager },
      // The managed Mutagen agent is a genuine child-process boundary. This faithful
      // duplex substitutes only that external artifact and echoes the bytes its stdin consumes.
      openRootedAgent: async () => {
        const stream = new PassThrough();
        rootedAgents.push(stream);
        return {
          stream,
          stop: async () => {
            stream.destroy();
          },
        };
      },
    });
    let sourceRuntime: Awaited<ReturnType<typeof createDaemonMachineIrohRuntime>> | null = null;
    let targetRuntime: Awaited<ReturnType<typeof createDaemonMachineIrohRuntime>> | null = null;
    let admission: Awaited<ReturnType<typeof startPeerMediationLoopbackServer>> | null = null;
    try {
      await targetAuthority.prepareBootstrapHere({
        v: 1,
        bootstrapOperationId: operationId,
        targetBootstrap: 'use_existing',
        owner: {
          kind: 'copy_once',
          operation: {
            v: 1,
            operationId,
            controllerMachineId: sourceMachineId,
            alphaWorkspaceRefId: sourceWorkspaceRefId,
            betaWorkspaceRefId: targetWorkspaceRefId,
            contentPolicy: {
              v: 1,
              selection: 'all_files',
              extraIgnorePatterns: [],
              extraIncludePatterns: [],
              policyDigest: computeWorkspaceSyncPolicyDigest({
                v: 1,
                selection: 'all_files',
                extraIgnorePatterns: [],
                extraIncludePatterns: [],
              }),
            },
          },
        },
        targetWorkspaceRefId,
        endpointRole: 'beta',
        policyDigest: computeWorkspaceSyncPolicyDigest({
          v: 1,
          selection: 'all_files',
          extraIgnorePatterns: [],
          extraIncludePatterns: [],
        }),
        createIfMissing: true,
      });

      sourceRuntime = await createDaemonMachineIrohRuntime({
        happyHomeDir: sourceHome,
        relayConfig: { relayPolicy: 'disabled', relayUrls: [] },
        native,
      });
      targetRuntime = await createDaemonMachineIrohRuntime({
        happyHomeDir: targetHome,
        relayConfig: { relayPolicy: 'disabled', relayUrls: [] },
        native,
      });
      expect(sourceRuntime.available).toBe(true);
      expect(targetRuntime.available).toBe(true);
      if (!sourceRuntime.available || !targetRuntime.available) return;

      admission = await startPeerMediationLoopbackServer({
        nowMs: () => nowMs,
        expected: {
          accountId,
          machineId: targetMachineId,
          flowKind: 'machine_rpc',
          routeKind: 'loopback_direct',
          endpointFingerprint: targetRuntime.endpoint.endpointId,
        },
        trustRoots,
        endpointExpiresAt: 301_000,
        irohMachineAdmission: {
          localEndpointId: targetRuntime.endpoint.endpointId,
          role: 'acceptor',
          allowedFlows: ['workspace_sync'],
          resolveApplicationTarget: async ({ handshake }) => {
            if (handshake.flow !== 'workspace_sync' || handshake.initiator.kind !== 'machine') return null;
            const ingress = await targetAuthority.acquireWorkspaceSyncMachineIngress({
              operationId: handshake.operationId,
              sourceMachineId: handshake.initiator.machineId,
              targetMachineId: handshake.target.machineId,
            }).catch((error: unknown) => {
              targetIngressFailure = error instanceof Error ? error.message : String(error);
              throw error;
            });
            return { port: ingress.port, localCapability: ingress.localCapability };
          },
        },
      });
      await targetRuntime.startAttemptAcceptor({ admissionPort: Number(new URL(admission.url).port) });

      const targetMachine = {
        id: targetMachineId,
        operationProtocolCapabilitiesRevision: 7,
        operationProtocolCapabilities: {
          irohMachineEndpoint: { protocolVersions: [1], ...targetRuntime.endpoint },
        },
      };
      const readTargetMachine = vi.fn(async () => targetMachine);
      const open = createWorkspaceMachineCarrierTunnelOpen({
        accountId,
        localMachineId: sourceMachineId,
        runtime: sourceRuntime,
        resolveTrustRoots: () => trustRoots,
        readTargetMachine,
        mintGrant: createGrantMint(signingKeyPair.secretKey),
        nowMs: () => nowMs,
      });
      const tunnel = await open({
        operationId,
        sourceMachineId,
        targetMachineId,
        flow: 'workspace_sync',
      });
      expect(tunnel.observedPath).toBe(expectedPath);
      const connection = await connectWorkspaceSyncMachineTunnel(tunnel);
      const socket = connection.stream;
      const payload = Buffer.from('machine/1-to-lane08-nonzero-bytes');
      const echoed = once(socket, 'data');
      socket.write(payload);
      let echoedBytes: Buffer;
      try {
        [echoedBytes] = await echoed as [Buffer];
      } catch (error) {
        const acceptorHandle = nativeStartMachineAcceptor.mock.calls[0]?.[0].endpointHandle;
        const tunnelStarted = await nativeStartMachineTunnel.mock.results[0]?.value;
        const [acceptorStatus, tunnelStatus] = await Promise.all([
          acceptorHandle ? native.getMachineAcceptorStatus(acceptorHandle) : null,
          tunnelStarted ? native.getMachineTunnelStatus(tunnelStarted.machineTunnelId) : null,
        ]);
        throw new Error(`No composed echo: ${JSON.stringify({ rootedAgents: rootedAgents.length, targetIngressFailure, acceptorStatus, tunnelStatus })}`, { cause: error });
      }
      expect(Buffer.from(echoedBytes)).toEqual(payload);
      expect(payload.byteLength).toBeGreaterThan(0);
      expect(readTargetMachine).toHaveBeenCalledTimes(2);
      expect(rootedAgents).toHaveLength(1);
      expect(nativeStartMachineTunnel).toHaveBeenCalledTimes(1);

      socket.end();
      socket.destroy();
      await connection.stop();
      await connection.stop();
      await waitFor(
        () => rootedAgents[0]?.destroyed === true,
        'Lane 08 rooted agent remained leased after the native stream half-close/cancellation',
      );

      const invalidOpen = createWorkspaceMachineCarrierTunnelOpen({
        accountId,
        localMachineId: sourceMachineId,
        runtime: sourceRuntime,
        resolveTrustRoots: () => trustRoots,
        readTargetMachine,
        mintGrant: createGrantMint(signingKeyPair.secretKey, { corruptSignature: true }),
        nowMs: () => nowMs,
      });
      await expect(invalidOpen({
        operationId: `${operationId}-invalid`,
        sourceMachineId,
        targetMachineId,
        flow: 'workspace_sync',
      })).rejects.toMatchObject({ code: 'grant_bad_signature' });
      expect(nativeStartMachineTunnel).toHaveBeenCalledTimes(1);
      expect(rootedAgents).toHaveLength(1);
      expect(callMachineRpc).not.toHaveBeenCalled();

      await targetAuthority.releaseAllRetainedBootstraps();
      const ownershipProbe = await rootOwnershipManager.tryAcquire({
        ownerId: 'post-carrier-cleanup-probe',
        canonicalRoot: targetRoot,
        operation: 'bootstrap',
      });
      expect('kind' in ownershipProbe).toBe(false);
      if (!('kind' in ownershipProbe)) await ownershipProbe.release();
    } finally {
      await sourceRuntime?.shutdown().catch(() => undefined);
      await targetRuntime?.shutdown().catch(() => undefined);
      await admission?.stop().catch(() => undefined);
      await targetAuthority.releaseAllRetainedBootstraps().catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
      await testController.restoreAutomatic();
      expect(testController.getObservedPath()).toBe('unknown');
    }
  }, 120_000);
});
