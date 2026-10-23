import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { registerSessionProviderInputAdmissionRpc } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { daemonPost } from '../controlHttp';
import { createManagedActivityInventory } from '../lifecycle/managedActivity';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '../types';

it('keeps simulated 300s healthy-runner observations off Home while real activity hints and explicit reads remain fresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-healthy-live-work-'));
  const network = await createRequesterCurrentnessSocketHarness();
  const ids = ['c1234567890123456789012345', 'c2234567890123456789012345'];
  const sessions = new Map<number, TrackedSession>(ids.map((happySessionId, index) => [index + 1, {
    pid: index + 1, startedBy: 'daemon', happySessionId,
  }]));
  const queues = ids.map(() => new MessageQueue2<string>(() => 'mode'));
  const runners = new Map(ids.map((sessionId, index) => {
    const consumer = createSessionProviderInputConsumer({ messageQueue: queues[index], session: {
      waitForMetadataUpdate: async () => false,
      getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }),
      readRuntimeActivitySnapshotTail: () => ({ sequence: 1, custody: null, settlement: {
        identity: { mutationKey: `runtime:${sessionId}`, admissionOrder: 1 }, desiredValue: { state: 'idle', activeCount: 0 },
        result: 'applied', committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 }, committedRevision: 1,
      } }),
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const manager = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    registerSessionProviderInputAdmissionRpc({ consumer, rpcHandlerRegistrar: manager });
    return [sessionId, manager] as const;
  }));
  let activityRequests = 0;
  network.server.on('connection', socket => {
    socket.on(SOCKET_RPC_EVENTS.CALL, async (request: SocketRpcRequestPayload, ack: (reply: unknown) => void) => {
      activityRequests += 1;
      const manager = runners.get(request.method.split(':')[0]);
      if (!manager) throw new Error('Unexpected Session RPC target');
      ack({ ok: true, result: await manager.handleRequest(request) });
    });
  });
  const homeRequests: string[] = [];
  let homeUnavailable = false;
  // Only Home HTTP and its network socket endpoint are substituted. Startup,
  // control IPC, inventory, Session transport, RPC codec and host input stay real.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    homeRequests.push(path);
    if (homeUnavailable) throw new Error('Fixture Home unavailable');
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    const sessionId = path.split('/').at(-1);
    if (sessionId && ids.includes(sessionId)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, metadata: JSON.stringify({ machineId: 'machine', path: directory }), metadataLayoutVersion: 0,
      dataEncryptionKey: null, encryptionMode: 'plain',
    }) } };
    throw new Error(`Unexpected Home read: ${path}`);
  });
  let fixture: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
  let inventory: ReturnType<typeof createManagedActivityInventory> | undefined;
  let unsubscribe = () => {};
  const observations: Array<ReturnType<ReturnType<typeof createManagedActivityInventory>['read']>> = [];
  try {
    fixture = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: join(directory, 'home'),
      activeServerDir: join(directory, 'home', 'servers', 'healthy-home'), serverId: 'healthy-home',
      serverHttpBaseUrl: 'https://healthy-home.invalid', machineId: 'machine', custodianAccountId: 'owner',
      credentials: { token: 'healthy-fixture', encryption: null },
      connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
      registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: sessions,
      getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    });
    inventory = createManagedActivityInventory({ producers: [fixture.runtime.sessionLiveWorkProducer] });
    const initial = await inventory.read();
    expect(initial).toMatchObject({ coverage: 'complete', idleSince: expect.any(Number) });
    expect(initial.items).toHaveLength(8);
    expect(initial.items.every(item => item.state === 'settled')).toBe(true);
    expect(activityRequests).toBe(2);
    // Join the inventory's existing in-flight observation on a real notification;
    // this does not add a read when no notification exists or cache a completed read.
    unsubscribe = fixture.runtime.sessionLiveWorkProducer.subscribe(() => observations.push(inventory!.read()));
    homeRequests.length = 0;
    activityRequests = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.now();
    for (let elapsed = 30_000; elapsed <= 300_000; elapsed += 30_000) {
      vi.setSystemTime(startedAt + elapsed);
      for (const tracked of sessions.values()) await fixture.runtime.onTrackedSessionHealthy(tracked);
    }
    await Promise.all(observations.splice(0));
    expect(homeRequests).toEqual([]);
    expect(activityRequests).toBe(0);

    const hint = async () => {
      const response = await daemonPost('/session-activity-changed', { sessionId: ids[0] }, {
        timeoutMs: null, target: { pid: process.pid, httpPort: fixture!.runtime.controlPort, controlToken: fixture!.runtime.controlToken },
      });
      expect(response).toEqual({ ok: true });
      const results = await Promise.all(observations.splice(0));
      expect(results).toHaveLength(1);
      return results[0];
    };
    queues[0].pushImmediate('fixture input', 'mode');
    const busy = await hint();
    expect(busy.coverage).toBe('complete');
    expect(busy.items.find(item => item.ownerRef === sessions.get(1) && item.category === 'input')?.state).toBe('active');
    expect(activityRequests).toBe(2);
    expect(homeRequests.length).toBeGreaterThan(0);

    queues[0].discardMatching(() => true);
    homeUnavailable = true;
    expect(await hint()).toMatchObject({ coverage: 'unknown' });
    homeUnavailable = false;
    const beforeRecovery = activityRequests;
    const recovered = await inventory.read();
    expect(recovered).toMatchObject({ coverage: 'complete', idleSince: expect.any(Number) });
    expect(recovered.items.every(item => item.state === 'settled')).toBe(true);
    expect(activityRequests - beforeRecovery).toBe(2);
  } finally {
    unsubscribe();
    inventory?.dispose();
    vi.useRealTimers();
    try { await fixture?.dispose(); }
    finally {
      try { await network.close(); }
      finally { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); }
    }
  }
});
