import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
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
    // This is the Machine socket boundary; startup, the private cache, source
    // reader, destination admission and Pending producer all execute for real.
    const transport = { ...createApiMachineTransportFixture(),
      onSessionChanged: (listener: NonNullable<typeof changedSession>) => { changedSession = listener; return () => { changedSession = undefined; }; },
      onSessionFollowRulesChanged: () => () => {},
      resolveInstalledAccountObservationRuntime: async () => ({ accountId, credentials, machineId, serverId,
        serverHttpBaseUrl: origin, isCurrent: async () => true }),
      setRPCHandlers: () => ({}), registerLiveStreamRelayRoutes: vi.fn(), connect: vi.fn(),
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
    } finally {
      if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
      await host.dispose(); restoreHttp(); await app.close();
    }
  });
});
