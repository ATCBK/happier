import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { createApiSessionClientFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readInstallationIdentityIfExistsSync } from '../identity/store';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt, type BootstrapMachineSyncRuntimeParams } from './bootstrapMachineSyncRuntime';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createSessionFollowContextReconciler } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from '@/agent/runtime/session/follow/sessionFollowSourceHydrator';
import { SessionFollowObservePendingResponseV1Schema, type SessionFollowSessionPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

it('routes a source-only Account change through the installed private rule cache and exact receiver admission without an edge', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'follow-first-source-change-' }, async ({ homeDir }) => {
    const accountId = 'receiver-account';
    const machineId = 'receiver-machine';
    const sourceSessionId = 'c111111111111111111111111';
    const destinationSessionId = 'c222222222222222222222222';
    const serverId = 'follow-home';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`, encryption: null };
    const origin = new URL(resolveServerHttpBaseUrl()).origin;
    const pending: unknown[] = [];
    const observed: string[] = [];
    const httpRequests: string[] = [];
    const runRouteReads: unknown[] = [];
    const workflowIds = ['followed-workflow', 'unrelated-workflow'];
    const discussionId = 'followed-discussion';
    const metadata = JSON.stringify({ path: homeDir, host: 'host', machineId });
    const source = createSessionRecordFixture({ id: sourceSessionId, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata, ownerAccountId: 'foreign-source-owner', origin: { kind: 'none' }, seq: 2, archivedAt: null, active: true });
    const destination = createSessionRecordFixture({ id: destinationSessionId, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata, ownerAccountId: accountId, origin: { kind: 'none' }, archivedAt: null, active: true });
    const rule = { ruleId: 'new-rule', version: 0, receiver: { kind: 'session', sessionId: destinationSessionId },
      inception: { createdAt: 100, accountChangeCursor: 5 },
      content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'] }),
        policy: { preset: 'important' } } } };
    const app = fastify();
    app.addHook('onRequest', async request => {
      httpRequests.push(`${request.method} ${request.url}`);
      expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
    });
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/session-follow-rules', async request => ({ rules: [rule],
      ...(new URL(request.url, origin).searchParams.has('destinationSessionId') ? { sourceRanges: { status: 'available', sources: [{
        sourceSessionId, delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 1 }, throughSeq: 2,
      }] } } : {}) }));
    app.get('/v2/account/session-follow-preferences', async () => ({ assigned: false, direct: false, team: false, group: false }));
    app.get('/v2/account/session-follows', async () => ({ follows: [...workflowIds.map(runId => ({
      source: { kind: 'workflow_run', runId }, following: true, persistent: true, policy: { preset: 'important' },
    })), { source: { kind: 'discussion', discussionId }, following: true, persistent: true, policy: { preset: 'important' } }] }));
    app.post('/v2/follows/sources/run-occurrence-routes', async request => {
      runRouteReads.push(request.body);
      // This is a source owner read, not fabricated terminal evidence. The
      // real stored-source/Activity acceptance composition has separate coverage.
      return { ok: false, v: 1, error: 'source_unavailable' };
    });
    app.get(`/v2/sessions/${sourceSessionId}`, async () => ({ session: source }));
    app.get(`/v2/sessions/${destinationSessionId}`, async () => ({ session: destination }));
    app.get(`/v2/sessions/${destinationSessionId}/delivery-mutes`, async () => ({ scopes: [] }));
    app.get(`/v1/sessions/${sourceSessionId}/messages`, async () => ({ messages: [{ id: 'new-original', localId: 'new-original', seq: 2,
      createdAt: 200, updatedAt: 200, sidechainId: null, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent',
        content: { type: 'event', id: 'new-original', data: { type: 'worker-report', summary: 'New original' } } } } }], hasMore: false }));
    app.post('/v2/sessions/:sessionId/follows/inactive-observations', async request => {
      const sessionId = (request.params as { sessionId: string }).sessionId;
      observed.push(sessionId);
      return sessionId === destinationSessionId ? { ok: true, v: 1, sessionId, target: { homeId: serverId, accountId,
        sessionId, machineId, installationId: readInstallationIdentityIfExistsSync()!.installationId },
      currentSourceSessionIds: [], observations: [] } : { ok: false, v: 1, error: 'forbidden' };
    });
    app.post(`/v2/sessions/${sourceSessionId}/follows/occurrence-routes`, async () => ({ ok: true, v: 1,
      sourceSessionId, originalCreatedAt: 200, routes: [] }));
    app.post(`/v2/sessions/${destinationSessionId}/pending`, async request => { pending.push(request.body); return { didWrite: true }; });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    let changedSession: Parameters<ApiMachineClient['onSessionChanged']>[0] | undefined;
    const changedFollows = new Set<Parameters<ApiMachineClient['onSessionFollowRulesChanged']>[0]>();
    let connectOptions: Parameters<ApiMachineClient['connect']>[0];
    // This is the Machine socket boundary; startup, the private cache, source
    // reader, destination admission and Pending producer all execute for real.
    const transport = { ...createApiMachineTransportFixture(),
      onSessionChanged: (listener: NonNullable<typeof changedSession>) => { changedSession = listener; return () => { changedSession = undefined; }; },
      onSessionFollowRulesChanged: (listener: Parameters<ApiMachineClient['onSessionFollowRulesChanged']>[0]) => {
        changedFollows.add(listener); return () => { changedFollows.delete(listener); };
      },
      resolveInstalledAccountObservationRuntime: async () => ({ accountId, credentials, machineId, serverId,
        serverHttpBaseUrl: origin, isCurrent: async () => true }),
      setRPCHandlers: () => ({}), registerLiveStreamRelayRoutes: vi.fn(),
      connect: (options: typeof connectOptions) => { connectOptions = options; },
      registerMachineAccessLossReceiver: () => {}, registerLocalServicesRoutes: () => {}, registerSimulatorPreviewRoutes: () => {},
      updateDaemonState: async () => 'published' as const, updateMachineMetadata: async () => 'published' as const,
      emitExternalSessionTranscriptUpdate: vi.fn(), sendMachineTransferEnvelope: vi.fn(), sendTransferRelayV2Envelope: vi.fn(),
      sendMachineLiveStreamRelayEnvelope: vi.fn(),
      getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
    };
    const apiMachine = transport as unknown as ApiMachineClient;
    const host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: homeDir, activeServerDir: homeDir, serverId,
      serverHttpBaseUrl: origin, machineId, custodianAccountId: accountId, credentials,
      connectedServicesMaterializationBaseDir: join(homeDir, 'materialized'), registry: new ConnectedServiceRuntimeRegistry(),
      trackedSessions: new Map(), getRequester: () => null, getApiMachineForSessions: () => apiMachine,
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      startup: { resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }) } });
    let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
    try {
      runtime = await bootstrapMachineSyncRuntime({ cliVersion: 'test', machineId, credentials,
        machine: { id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
        requesterServerId: serverId, preferredHost: 'host', happyHomeDir: homeDir, happyLibDir: homeDir,
        filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
        createConnectedApiMachine: () => apiMachine as NonNullable<Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>>,
        attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
        startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
        spawnSessionForInternalResume: async () => { throw new Error('A quiet Follow update must not spawn'); },
        spawnSession: async () => { throw new Error('A quiet Follow update must not spawn'); },
        stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => true,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }),
        dispatchSessionFollowOccurrence: host.runtime.dispatchSessionFollowOccurrence,
        loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
        directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
        connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null, daemonServerWorkScheduler: {} as never,
      });
      if (!changedSession) throw new Error('Missing Account Session observer');
      await changedSession({ sessionId: sourceSessionId, cursor: 6 });
      expect(pending, JSON.stringify({ httpRequests, observed })).toHaveLength(1);
      expect(observed).toContain(destinationSessionId);
      expect(pending[0]).toMatchObject({ followDeliveryV1: { original: { sourceSessionId, sourceMessage: { localId: 'new-original', seq: 2 } } },
        followSources: [{ evaluation: 'receiver', rule: { ruleId: 'new-rule', ruleVersion: 0 } }] });
      expect(pending[0]).not.toHaveProperty('followRelations');
      if (!changedFollows.size) throw new Error('Missing Account Follow observer');
      await Promise.all([...changedFollows].map(listener => listener({ full: false, workflowRunIds: [workflowIds[0]!] })));
      expect(runRouteReads).toEqual([{ v: 1, source: { kind: 'workflow_run', runId: workflowIds[0] } }]);
      runRouteReads.length = 0;
      await Promise.all([...changedFollows].map(listener => listener({ full: false, workflowRunIds: [], discussionIds: [discussionId] })));
      expect(runRouteReads).toEqual([{ v: 1, source: { kind: 'discussion', discussionId } }]);
      runRouteReads.length = 0;
      await connectOptions?.onConnect?.();
      expect(runRouteReads).toEqual([...workflowIds.map(runId => ({ v: 1, source: { kind: 'workflow_run', runId } })),
        { v: 1, source: { kind: 'discussion', discussionId } }]);
    } finally {
      if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
      await host.dispose(); restoreHttp(); await app.close();
    }
  });
});

it.each([
  { dispatcherState: 'unavailable', eventType: 'ready', policy: { preset: 'everything' }, delivery: 'wake' },
  { dispatcherState: 'available', eventType: 'ready', policy: { preset: 'everything' }, delivery: 'wake' },
  { dispatcherState: 'unavailable', eventType: 'goal-changed', policy: { preset: 'everything' }, delivery: 'wake' },
  { dispatcherState: 'available', eventType: 'goal-changed', policy: { preset: 'everything' }, delivery: 'wake' },
  { dispatcherState: 'available', eventType: 'ready', policy: { preset: 'important' }, delivery: 'next_turn' },
  { dispatcherState: 'available', eventType: 'goal-changed', policy: { preset: 'important' }, delivery: 'next_turn' },
  { dispatcherState: 'available', eventType: 'ready', policy: { preset: 'quiet' }, delivery: 'next_turn' },
  { dispatcherState: 'available', eventType: 'goal-changed', policy: { preset: 'quiet' }, delivery: 'next_turn' },
  { dispatcherState: 'available', eventType: 'goal-changed', policy: { preset: 'custom', events: {
    goal_changed: { delivery: 'interrupt' },
  } }, delivery: 'wake' },
  { dispatcherState: 'available', eventType: 'goal-changed', policy: { preset: 'custom', events: {} }, delivery: null },
  { dispatcherState: 'available', eventType: 'cont28', policy: { preset: 'important' }, delivery: 'next_turn' },
] satisfies ReadonlyArray<{ dispatcherState: 'available' | 'unavailable'; eventType: 'ready' | 'goal-changed' | 'cont28';
  policy: FollowPolicyV1; delivery: 'wake' | 'next_turn' | null }>)('defers an original-backed update to original admission ($dispatcherState dispatcher, $eventType, $policy.preset)', async ({ dispatcherState, eventType, policy, delivery }) => {
  await withConfiguredDaemonTestHome({ prefix: 'follow-original-wake-' }, async ({ homeDir }) => {
    const accountId = 'receiver-account';
    const machineId = 'receiver-machine';
    const sourceSessionId = 'c111111111111111111111111';
    const destinationSessionId = 'c222222222222222222222222';
    const serverId = 'follow-home';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`, encryption: null };
    const origin = new URL(resolveServerHttpBaseUrl()).origin;
    const metadata = JSON.stringify({ path: homeDir, host: 'host', machineId, flavor: 'codex',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} }, codexSessionId: 'native-receiver' });
    const source = createSessionRecordFixture({ id: sourceSessionId, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata, ownerAccountId: accountId, origin: { kind: 'none' }, seq: eventType === 'cont28' ? 15 : 1, archivedAt: null, active: true,
      latestTurnId: 'source-turn', latestTurnStatus: 'completed', pendingReviewRuns: 0 });
    const destination = createSessionRecordFixture({ id: destinationSessionId, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata, ownerAccountId: accountId, origin: { kind: 'none' }, archivedAt: null, active: true });
    const observation: SessionFollowSessionPendingObservationV1 = { sourceSessionId, destinationSessionId,
      ...(eventType === 'ready' || eventType === 'cont28' || policy.preset !== 'everything'
        ? { relation: 'manager' as const, attachedAt: 1 } : { relation: 'follower' as const }),
      policy, delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: eventType === 'cont28' ? 9 : 0 },
      observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: source.seq, turn: { id: 'source-turn', status: 'completed' } } };
    let rulesAvailable = dispatcherState === 'available';
    let routesAvailable = true;
    let losePendingResponse = eventType === 'cont28';
    const pending: unknown[] = [];
    const legacyContexts: unknown[] = [];
    const app = fastify();
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/session-follow-rules', async (_request, reply) => rulesAvailable
      ? { rules: [] } : reply.code(503).send({ error: 'unavailable' }));
    app.get('/v2/account/session-follow-preferences', async () => ({ assigned: false, direct: false, team: false, group: false }));
    app.get('/v2/account/session-follows', async () => ({ follows: [] }));
    app.get(`/v2/sessions/${destinationSessionId}/follows/sessions`, async () => ({ sources: [] }));
    app.get(`/v2/sessions/${sourceSessionId}`, async () => ({ session: source }));
    app.get(`/v2/sessions/${destinationSessionId}`, async () => ({ session: destination }));
    app.get(`/v2/sessions/${destinationSessionId}/delivery-mutes`, async () => ({ scopes: [] }));
    app.get(`/v1/sessions/${sourceSessionId}/messages`, async () => ({ messages:
      (eventType === 'cont28' ? [{ seq: 10, type: 'ready' }, { seq: 11, type: 'goal-changed' }, { seq: 15, type: 'ready' }]
        : [{ seq: 1, type: eventType }]).map(({ seq, type }) => ({ id: `original-${seq}`, localId: `original-${seq}`, seq,
        createdAt: 200 + seq, updatedAt: 200 + seq, sidechainId: null, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent',
          content: { type: 'event', id: `original-${seq}`, data: { type,
            ...(type === 'ready' ? { completedTurnId: eventType === 'cont28' && seq === 10 ? 'old-source-turn' : 'source-turn' } : {}) } } } } })), hasMore: false }));
    app.post('/v2/sessions/:sessionId/follows/inactive-observations', async request => {
      const sessionId = (request.params as { sessionId: string }).sessionId;
      return { ok: true, v: 1, sessionId, target: { homeId: serverId, accountId, sessionId, machineId,
        installationId: readInstallationIdentityIfExistsSync()!.installationId },
        currentSourceSessionIds: [sourceSessionId], observations: [observation] };
    });
    app.post(`/v2/sessions/${sourceSessionId}/follows/occurrence-routes`, async (_request, reply) => routesAvailable
      ? { ok: true, v: 1, sourceSessionId, originalCreatedAt: 200, routes: [observation] }
      : reply.code(503).send({ error: 'unavailable' }));
    app.post(`/v2/sessions/${destinationSessionId}/pending`, async (request, reply) => {
      pending.push(request.body);
      // HTTP boundary only: custody may have committed before its response is lost.
      if (losePendingResponse) { losePendingResponse = false; return reply.code(503).send({ error: 'unavailable' }); }
      return { didWrite: true };
    });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    let changedSession: Parameters<ApiMachineClient['onSessionChanged']>[0] | undefined;
    const transport = { ...createApiMachineTransportFixture(),
      onSessionChanged: (listener: NonNullable<typeof changedSession>) => { changedSession = listener; return () => {}; },
      registerMachineAccessLossReceiver: () => () => {},
      resolveInstalledAccountObservationRuntime: async () => ({ accountId, credentials, machineId, serverId,
        serverHttpBaseUrl: origin, isCurrent: async () => true }),
      setRPCHandlers: () => ({}), registerLiveStreamRelayRoutes: vi.fn(),
      connect: () => {}, registerLocalServicesRoutes: () => {}, registerSimulatorPreviewRoutes: () => {},
      updateDaemonState: async () => 'published' as const, updateMachineMetadata: async () => 'published' as const,
      emitExternalSessionTranscriptUpdate: vi.fn(), sendMachineTransferEnvelope: vi.fn(), sendTransferRelayV2Envelope: vi.fn(),
      sendMachineLiveStreamRelayEnvelope: vi.fn(),
      getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
    };
    const apiMachine = transport as unknown as ApiMachineClient;
    const host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: homeDir, activeServerDir: homeDir, serverId,
      serverHttpBaseUrl: origin, machineId, custodianAccountId: accountId, credentials,
      connectedServicesMaterializationBaseDir: join(homeDir, 'materialized'), registry: new ConnectedServiceRuntimeRegistry(),
      trackedSessions: new Map(), getRequester: () => null, getApiMachineForSessions: () => apiMachine,
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      startup: { resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }) } });
    // Substitute only the publisher socket. The resumed host's selection and
    // source hydration stay real, so a process launch cannot stand in for delivery.
    const session = Object.assign(createApiSessionClientFixture(), { sessionId: destinationSessionId,
      runSessionFollowSourceRequest: <T>({ request }: { request: () => T }): T => request(),
      observePendingSessionFollow: async () => SessionFollowObservePendingResponseV1Schema.parse({ ok: true, v: 1,
        sessionId: destinationSessionId, publisherGeneration: '1', currentSourceSessionIds: [sourceSessionId], observations: [observation] }),
    });
    const reconcile = createSessionFollowContextReconciler({ session,
      hydrateObservation: createSessionFollowSourceHydrator({ session, credentials }), maxFollowContextUtf8Bytes: 8192 });
    let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
    try {
      runtime = await bootstrapMachineSyncRuntime({ cliVersion: 'test', machineId, credentials,
        machine: { id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
        requesterServerId: serverId, preferredHost: 'host', happyHomeDir: homeDir, happyLibDir: homeDir,
        filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
        createConnectedApiMachine: () => apiMachine as NonNullable<Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>>,
        attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
        startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
        spawnSessionForInternalResume: async () => {
          legacyContexts.push(await reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' }));
          return { type: 'success', sessionId: destinationSessionId };
        },
        spawnSession: async () => { throw new Error('Follow must use internal resume'); },
        stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => false,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }),
        dispatchSessionFollowOccurrence: host.runtime.dispatchSessionFollowOccurrence,
        loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
        directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
        connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null, daemonServerWorkScheduler: {} as never,
      });
      if (!changedSession) throw new Error('Missing Account Session observer');
      await changedSession({ sessionId: destinationSessionId, cursor: 1 });
      const beforeRetry = [...legacyContexts];
      rulesAvailable = true;
      if (eventType === 'cont28') {
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ followDeliveryV1: { delivery: 'next_turn', event: { kind: 'finished' },
          original: { sourceMessage: { seq: 10 } } } });
        routesAvailable = false;
        await changedSession({ sessionId: destinationSessionId, cursor: 2 });
        expect(pending).toHaveLength(1);
        expect(legacyContexts).toEqual([]);
        routesAvailable = true;
      }
      await changedSession({ sessionId: destinationSessionId, cursor: 3 });
      expect(pending).toHaveLength(eventType === 'cont28' ? 4 : delivery === null ? 0 : dispatcherState === 'available' ? 2 : 1);
      for (const request of pending) expect(request).toMatchObject({ followDeliveryV1: { delivery } });
      if (eventType === 'cont28') expect(pending).toMatchObject([10, 10, 11, 15].map(seq => ({
        followDeliveryV1: { original: { sourceMessage: { seq } } },
      })));
      expect(beforeRetry).toEqual([]);
      expect(legacyContexts).toEqual([]);
    } finally {
      if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
      await host.dispose(); restoreHttp(); await app.close();
    }
  });
});
