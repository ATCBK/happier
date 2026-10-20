import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { describe, expect, it } from 'vitest';

import { ApiMachineClient } from '@/api/apiMachine';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import type { Machine } from '@/api/types';
import { MachineUpdateStateRequestSchema, MachineUpdateMetadataRequestSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { MachinePublishedDaemonStateV1Schema, MachinePublishedMetadataV1Schema, StoredMachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { resolveAcpPlatformFitV1 } from '@happier-dev/protocol/acp/catalog/registry/acpPlatformFitV1';
import { AcpBackendLaunchV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createDeferred } from '@/testkit/async/deferred';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from './serverWork';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt } from './machine/bootstrapMachineSyncRuntime';
import type { BootstrapMachineSyncRuntimeResult } from './machine/bootstrapMachineSyncRuntime';
import {
  isMachineDaemonFiniteTransferApplicationSupported,
  isMachineDaemonIrohTransferApplicationSupported,
} from '../../../ui/sources/sync/domains/transfers/runtime/transferRuntime/availability/machineDaemonTransferState';
import { createDaemonTransferRuntimeState, createDaemonTransferRuntimeStatePublisher } from './transferRuntimeState';
import { buildMachineDisplayMetadata } from '../../../ui/sources/sync/domains/machines/machineDisplayRenderable';

describe('lazy transfer declaration through Machine publication', () => {
  it('publishes the initial declaration through the real bootstrap connected edge before any lazy listener event', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-transfer-bootstrap-'));
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'transfer-test-home' } } });
    const http = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(features));
    });
    const sockets = new Server(http, { path: '/v1/updates/' });
    const machine: Machine = { id: 'bootstrap-transfer-machine', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: { status: 'running' }, daemonStateVersion: 0 };
    const codec = createMachineContentCodec(machine);
    const client = new ApiMachineClient('test-token', machine, undefined, {
      resolveServerFeaturesSnapshot: async () => ({ status: 'ready', features }),
    });
    let connected = false;
    let observed: unknown;
    const metadataPublished = createDeferred<ReturnType<typeof StoredMachinePublishedMetadataV1Schema.parse>>();
    let version = 0;
    sockets.on('connection', socket => {
      connected = true;
      socket.on(SOCKET_RPC_EVENTS.REGISTER, (request: { method: string }) => socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method: request.method }));
      socket.on('machine-update-operation-protocol-capabilities', (_raw, acknowledge) => acknowledge({ v: 1, result: 'success', revision: 1 }));
      socket.on('machine-update-metadata', (raw: unknown, acknowledge: (answer: unknown) => void) => {
        const request = MachineUpdateMetadataRequestSchema.parse(raw);
        const metadata = StoredMachinePublishedMetadataV1Schema.parse(codec.decodeStored(request.metadata));
        acknowledge({ result: 'success', version: 1, metadata: request.metadata });
        metadataPublished.resolve(metadata);
      });
      socket.on('machine-update-state', (raw: unknown, acknowledge: (answer: unknown) => void) => {
        const request = MachineUpdateStateRequestSchema.parse(raw);
        observed = MachinePublishedDaemonStateV1Schema.parse(codec.decodeStored(request.daemonState));
        version += 1;
        acknowledge({ result: 'success', version, daemonState: request.daemonState });
      });
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback socket endpoint');
    const initialTransferState = createDaemonTransferRuntimeState({ directPeer: {
      featureEnabled: false, serverEnabled: false, bindHost: '127.0.0.1', bindPort: 0, advertisedHosts: [],
    } });
    const publisher = createDaemonTransferRuntimeStatePublisher({ initialTransferState });
    let runtime: BootstrapMachineSyncRuntimeResult | undefined;
    try {
      expect(connected).toBe(false);
      runtime = await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => bootstrapMachineSyncRuntime({
        cliVersion: 'test', machineId: machine.id, machine,
        happyHomeDir: homeDir, happyLibDir: homeDir, preferredHost: '127.0.0.1', filesystemAccessPolicy: { kind: 'osUser' },
        takeoverRequested: false, isShuttingDown: () => false,
        createConnectedApiMachine: () => client,
        attachTransferRuntimeStatePublisher: target => publisher.attachApiMachine(target),
        startAutomationWorkerForMachine: () => null,
        startMemoryWorkerForMachine: async () => null,
        startVoiceInferenceWorkerForMachine: async () => null,
        spawnSessionForInternalResume: async () => ({ type: 'success', sessionId: 'unused' }),
        spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => false,
        loadLocalSessionMetadataForHandoff: async () => null,
        beforeShutdown: async () => {}, requestShutdown: () => {}, directPeerServerLifecycle: null,
        directTransferRegistryHost: createCliRegistryHostV1(), connectedServiceRefreshLoopHandle: null,
        connectedServiceQuotasLoopHandle: null,
        daemonServerWorkScheduler: createDaemonServerWorkScheduler({ budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }) }),
        getServerFeaturesSnapshot: () => ({ status: 'ready', features }),
      }));
      await expect.poll(() => isMachineDaemonFiniteTransferApplicationSupported(observed)).toBe(true);
      expect(connected).toBe(true);
      expect(observed).toMatchObject({ transfer: initialTransferState });
      expect(isMachineDaemonIrohTransferApplicationSupported(observed)).toBe(false);
      // Exercise the actual reconnect publication, strict wire/storage readers and
      // UI projection; a metadata helper alone cannot detect a missing bootstrap binding.
      const observedMetadata = await metadataPublished.promise;
      const display = buildMachineDisplayMetadata(MachinePublishedMetadataV1Schema.parse(observedMetadata))!;
      expect(display.arch).toBe(arch());
      expect(display.platform).toBe(process.platform);
      const launch = AcpBackendLaunchV1Schema.parse({ kind: 'npm', package: '@fixture/agent', version: '1.0.0', args: [] });
      expect(resolveAcpPlatformFitV1(launch, {
        platform: display.platform ?? null, arch: display.arch ?? null,
      })).toMatchObject({ kind: 'can_run', via: 'npm' });
    } finally {
      if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
      else await client.shutdown();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it.each(['plain', 'e2ee'] as const)('publishes and refreshes the current Home application through real %s socket/codec wiring', async mode => {
    const initialTransferState = createDaemonTransferRuntimeState({ directPeer: {
      featureEnabled: false, serverEnabled: false, bindHost: '127.0.0.1', bindPort: 0, advertisedHosts: [],
    } });
    const machine: Machine = {
      id: 'lazy-transfer-machine', metadata: null, metadataVersion: 0, daemonStateVersion: 0,
      daemonState: { status: 'running', pid: 123 },
      ...(mode === 'plain' ? { encryptionMode: 'plain' as const }
        : { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' as const }),
    };
    const codec = createMachineContentCodec(machine);
    const client = new ApiMachineClient('test-token', machine);
    const http = createServer();
    const sockets = new Server(http);
    let version = 0;
    let published: unknown;
    // Home is the external transport boundary. Validate its real strict request
    // and stored-content consumers; production publication and crypto stay real.
    sockets.on('connection', socket => socket.on('machine-update-state', (raw: unknown, acknowledge: (answer: unknown) => void) => {
      const request = MachineUpdateStateRequestSchema.parse(raw);
      published = MachinePublishedDaemonStateV1Schema.parse(codec.decodeStored(request.daemonState));
      expect(request.expectedVersion).toBe(version);
      version += 1;
      acknowledge({ result: 'success', version, daemonState: request.daemonState });
    }));
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback socket endpoint');
    const socket = io(`http://127.0.0.1:${address.port}`, { autoConnect: false, reconnection: false });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect();
      });
      // The already admitted transport is the private boundary exercised by
      // ApiMachineClient.updateDaemonState, without starting unrelated workers.
      Reflect.set(client, 'socket', socket);
      const publisher = createDaemonTransferRuntimeStatePublisher({ initialTransferState });
      await publisher.attachApiMachine(client);
      expect(isMachineDaemonFiniteTransferApplicationSupported(published)).toBe(true);
      expect(isMachineDaemonIrohTransferApplicationSupported(published)).toBe(false);
      expect(machine.daemonState?.transfer).toEqual(initialTransferState);
      expect(machine.daemonState?.pid).toBe(123);
      // A reconnect with a retained predecessor projection must use this live
      // bootstrap, even without a direct-listener lifecycle event.
      machine.daemonState = { status: 'running', pid: 456, transfer: {
        ...initialTransferState, supported: { import: false, export: false },
      } };
      await publisher.attachApiMachine(client);
      expect(isMachineDaemonFiniteTransferApplicationSupported(published)).toBe(true);
      expect(machine.daemonState?.transfer).toEqual(initialTransferState);
      expect(machine.daemonState?.pid).toBe(456);
    } finally {
      socket.disconnect();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
    }
  });
});
