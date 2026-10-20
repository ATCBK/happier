import axios from 'axios';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS, ProviderConnectionIdSchema, ProviderSettingsV1Schema, SessionModelSelectionV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { DaemonProviderModelProjectionRequestV1Schema, DaemonProviderModelProjectionResponseV1Schema, DaemonProviderModelsResponseV1Schema, DaemonProviderProbeResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createProviderProbeRequestFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import * as persistence from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createMachineSharedProviderGatewayResolver } from '@/daemon/machine/bootstrapMachineSyncRuntime';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderConnectionServices } from '@/providers/connections/runtimeServices';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createAccountScopedProviderModelProjectionReader } from '@/providers/modelManagement/remoteProjection';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { authorizeSessionModelTransitionProviderTargetWithLease } from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import type { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { createRuntimeProviderServices } from './runtimeServices';
import { createProviderManagedCatalogRuntimePort } from './managedRuntime';
import { exerciseGatewayStreamJourney, startGatewayJourneyUpstream } from './gatewayJourney.testkit';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { bindApiSessionSocketPairMock, createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';

const transport = vi.hoisted(() => ({ call: vi.fn<typeof callExactMachineRpc>() }));
const socketBoundary = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: socketBoundary.io }));
// Only the authenticated inter-Machine network boundary is replaced. Both
// daemons' catalog, authorization, managed process and endpoint owners are real.
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callExactMachineRpc: transport.call }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); transport.call.mockReset(); });

it('reports unavailable catalog preparation rather than an endpoint outage when Home admission spends the operation budget', () =>
  withConfiguredDaemonTestHome({ prefix: 'gateway-catalog-deadline-' }, async ({ homeDir }) => {
    let entered = () => {};
    let release = () => {};
    const targetEntered = new Promise<void>(resolve => { entered = resolve; });
    const targetReleased = new Promise<void>(resolve => { release = resolve; });
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller: createPluginReloadController(), physicalGateway: true, probeCatalog: true,
      resolveAccountTarget: async (target, signal) => {
        entered(); await targetReleased; signal.throwIfAborted();
        return target.kind === 'account' ? { account: target.account, displayName: 'Upstream' } : null;
      },
    });
    let pending: Promise<unknown> | undefined;
    try {
      const services = createRuntimeProviderServices({ machineId: fixture.machineId, happyHomeDir: homeDir,
        registry: fixture.contributes, featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => fixture.snapshot,
        resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
      });
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      pending = services.probe({ connectionId: 'run-gateway', machineId: fixture.machineId });
      await targetEntered;
      await vi.advanceTimersByTimeAsync(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs + 1);
      expect(await pending).toMatchObject({ status: 'error', error: {
        code: 'provider_catalog_unavailable', retryable: true, action: 'retry',
      } });
    } finally {
      release(); await pending; vi.useRealTimers(); await fixture.cleanup();
    }
  }));

it('composes G1 Gateway setup, hub and peer tool turns, isolation, outage, Pending, slow auth and grant recovery', () =>
  withConfiguredDaemonTestHome({ prefix: 'gateway-catalog-peer-' }, async ({ homeDir }) => {
    let onTargetRead: () => void | Promise<void> = () => {};
    let pool = { generation: 1, policy: { autoSwitch: false } };
    const upstream = await startGatewayJourneyUpstream();
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller: createPluginReloadController(), physicalGateway: true, probeCatalog: true,
      upstreamUrl: upstream.url, experimental: true,
      catalogModels: [{ id: 'gateway-model' }],
      resolveAccountTarget: async (target, signal) => {
        signal.throwIfAborted();
        await onTargetRead();
        return { account: target.kind === 'account' ? target.account
          : { service: target.service, accountId: 'upstream-account' }, displayName: 'Upstream',
          ...(target.kind === 'group' ? { group: { groupId: target.groupId, generation: pool.generation } } : {}) };
      },
    }).catch(async error => { await upstream.close(); throw error; });
    upstream.bind(fixture);
    try {
      if (!fixture.gateway) throw new Error('Expected physical gateway');
      const peerId = 'peer-worker';
      const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.fixture`, encryption: null };
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
      const base = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
        connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
          gatewayPlacement: { kind: 'machine', machineId: fixture.machineId },
          purposeBindingDefaults: { upstream: { kind: 'group', groupId: 'shared-pool',
            service: { pluginId: fixture.gateway!.pluginId, localId: 'accounts' } } } })),
      });
      const connection = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
        providerSettings: base, registry: fixture.contributes, dnsEvidenceByEndpointUrl: new Map() });
      if (connection.status !== 'resolved') throw new Error('Expected gateway connection');
      const settings = ProviderSettingsV1Schema.parse({ ...base,
        accountGrants: [{ v: 1, connectionId: 'run-gateway', confirmedAt: 1,
          connectionSecurityFingerprint: connection.record.connectionSecurityFingerprint }],
        machineGrants: [{ v: 1, connectionId: 'run-gateway', machineId: fixture.machineId, confirmedAt: 1,
          connectionSecurityFingerprint: connection.record.connectionSecurityFingerprint,
          endpointSetFingerprint: connection.record.endpointSetFingerprint }],
      });
      let catalog = splitProviderSettingsV1(settings).catalog;
      let revision = 1;
      let settingsVersion = 1;
      const snapshot = () => ({ ...fixture.snapshot, settingsVersion, rawSettings: {},
        scopeKey: resolveAccountSettingsScopeKey(credentials),
        providerConnectionsCatalog: { status: 'ready' as const, revision, catalog } });
      setActiveAccountSettingsSnapshot(snapshot());
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 1, settingsVersion, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
          status: 'present', revision, content: { t: 'plain', v: catalog } } };
        if (path === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: {} } } };
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
        if (path === '/v2/sessions/main-two') return { status: 404, data: { error: 'Session not found' } };
        // The real Session transport checks its Machine binding before connect.
        if (path === `/v1/access-keys/main-two/${encodeURIComponent(fixture.machineId)}`) {
          return { status: 200, data: { accessKey: 'journey-session-access-key' } };
        }
        if (path === '/v1/auth/ping') return { status: 200, data: {} };
        const history = emptyAccountSettingsHistoryCaptureResponse(path);
        if (history) return history;
        throw new Error(`Unexpected catalog HTTP boundary: ${path}`);
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/provider-connections');
        const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
        expect(mutation.expectedRevision).toBe(revision);
        if (mutation.content?.t !== 'plain') throw new Error('Expected Plain fixture');
        catalog = mutation.content.v;
        return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
      });
      const resolveSharedGateway = createMachineSharedProviderGatewayResolver({ machineId: fixture.machineId,
        readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId: fixture.machineId }) });
      const hub = createRuntimeProviderServices({ machineId: fixture.machineId, happyHomeDir: homeDir,
        featureGate: { isEnabled: () => true }, registry: fixture.contributes, getAccountSettingsSnapshot: snapshot,
        resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
        resolveSharedGateway,
        managedCatalogRuntime: createProviderManagedCatalogRuntimePort({ happyHomeDir: homeDir, resolveSharedGateway,
          acquireRegistryLease: async () => {
            const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
            if (!lease) throw new Error('Expected hub registry');
            return lease;
          },
        }),
      });
      const hubModels = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId, happyHomeDir: homeDir,
        featureGate: { isEnabled: () => true }, registry: fixture.contributes, getAccountSettingsSnapshot: snapshot,
        resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
        acquireRuntimeLease: async () => {
          const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
          if (!lease) throw new Error('Expected hub model registry');
          return lease;
        },
        modelSettingsMutation: async (): Promise<never> => { throw new Error('No model-settings mutation'); },
      });
      const rpc = new RpcHandlerManager({ scopePrefix: fixture.machineId, localMachineId: fixture.machineId,
        encryptionMode: 'plain', logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
          machineId: fixture.machineId, resolveCustodianAccountId: async () => 'account', resolveInstallationId: () => 'installation',
          verifyMachineAdmission: async () => true,
        }) });
      rpc.registerHandler(RPC_METHODS.DAEMON_PROVIDERS_PROBE, (request, context) => hub.probe(request, 'manual_refresh', { signal: context?.signal }));
      rpc.registerHandler('daemon.providers.models', request => hub.models(request));
      rpc.registerHandler(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        request => hubModels.projectModels(DaemonProviderModelProjectionRequestV1Schema.parse(request)));
      transport.call.mockImplementation(async ({ machineId, method, request, signal }) => {
        expect(machineId).toBe(fixture.machineId);
        signal?.throwIfAborted();
        const result = await rpc.handleRequest({ method: `${machineId}:${method}`, params: request,
          machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId,
            installationId: 'installation', role: 'manage', encryptionMode: 'plain' } });
        signal?.throwIfAborted();
        if (method === RPC_METHODS.DAEMON_PROVIDERS_PROBE) return DaemonProviderProbeResponseV1Schema.parse(result);
        if (method === 'daemon.providers.models') return DaemonProviderModelsResponseV1Schema.parse(result);
        return DaemonProviderModelProjectionResponseV1Schema.parse(result);
      });
      const peer = createRuntimeProviderServices({ machineId: peerId, happyHomeDir: homeDir,
        featureGate: { isEnabled: () => true }, registry: fixture.contributes,
        resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
      });
      const peerModels = createRuntimeProviderModelManagementServices({ machineId: peerId, happyHomeDir: homeDir,
        featureGate: { isEnabled: () => true }, registry: fixture.contributes,
        resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
        acquireRuntimeLease: async () => {
          const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
          if (!lease) throw new Error('Expected peer registry');
          return lease;
        },
        modelSettingsMutation: async (): Promise<never> => { throw new Error('No model-settings mutation'); },
      });
      const projectPeerModels = () => peerModels.projectModels({ machineId: peerId,
        agentTargetKey: fixture.agentTargetKey, sourceConnectionId: 'run-gateway', mode: 'management' });
      const request = { connectionId: ProviderConnectionIdSchema.parse('run-gateway'), machineId: peerId };
      expect(await peer.probe(request)).toMatchObject({ status: 'error', error: { code: 'provider_not_enabled_on_machine' } });
      expect(transport.call).not.toHaveBeenCalled();
      const connections = createRuntimeProviderConnectionServices({ machineId: peerId, credentials, happyHomeDir: homeDir,
        featureGate: { isEnabled: () => true }, resolveRegistry: async () => fixture.contributes,
        resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
        runtimeSummary: peer.summary,
      });
      const setEnabled = (enabled: boolean) => connections.mutateConnection({
        action: 'setEnabled', ...request, scope: 'machine', enabled,
      });
      const grant = await setEnabled(true);
      expect(grant, JSON.stringify(grant)).toMatchObject({ status: 'success' });
      expect(catalog.machineGrants.some(grant => grant.machineId === peerId)).toBe(true);
      expect(await peer.probe(request)).toMatchObject({ status: 'success', models: [{ id: 'gateway-model' }] });
      expect(await peer.models(request)).toMatchObject({ status: 'success', connectionId: request.connectionId,
        models: expect.arrayContaining([expect.objectContaining({ id: 'gateway-model' })]) });
      const experimental = await projectPeerModels();
      if (experimental.status !== 'success') throw new Error('Expected experimental source projection');
      const row = experimental.groups[0]!.rows.find(row => row.ref.modelId === 'gateway-model')!;
      expect(row.compatibility).toMatchObject({ result: { status: 'experimental' }, confirmed: false });
      const confirm = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 2,
        readCatalog: async () => ({ status: 'ready', revision, catalog }),
        readDefinitions: async () => [...fixture.contributes.providersByContributionKey].map(([contributionKey, contribution]) => ({
          contributionKey, definition: contribution.definition, provenance: contribution.provenance })),
        writeCatalog: async value => { expect(value.expectedRevision).toBe(revision); catalog = value.catalog; revision += 1;
          setActiveAccountSettingsSnapshot(snapshot()); return { status: 'updated' }; },
      });
      expect(await confirm(parseProviderActionRequestV1('providers.models.experimental.confirm', { action: 'confirmExperimental',
        connectionId: request.connectionId, expectedConnectionRevision: experimental.groups[0]!.connectionRevision,
        agentTargetKey: fixture.agentTargetKey, modelId: row.compatibility.result.status === 'experimental'
          && row.compatibility.result.confirmationScope.kind === 'model' ? row.ref.modelId : null,
        compatibilityFingerprint: row.compatibility.compatibilityFingerprint }), {})).toMatchObject({ ok: true, result: { status: 'success' } });
      // Account preferences have their own version. A publication while the
      // hub resolves its upstream must not revoke an unchanged Gateway grant.
      pool = { generation: pool.generation + 1, policy: { autoSwitch: true } };
      expect(await peer.probe(request)).toMatchObject({ status: 'success', models: [{ id: 'gateway-model' }] });
      onTargetRead = () => {
        settingsVersion += 1;
        setActiveAccountSettingsSnapshot(snapshot());
      };
      const localAfterPolicyChange = await hub.probe({ connectionId: request.connectionId, machineId: fixture.machineId });
      expect(localAfterPolicyChange, JSON.stringify(localAfterPolicyChange)).toMatchObject({ status: 'success', models: [{ id: 'gateway-model' }] });
      const afterPolicyChange = await peer.probe(request);
      expect(afterPolicyChange, JSON.stringify(afterPolicyChange)).toMatchObject({ status: 'success', models: [{ id: 'gateway-model' }] });
      onTargetRead = () => {};
      const callHub = transport.call.getMockImplementation()!;
      // Spawn admission is part of Session creation, not a catalog probe. A
      // slow exact-Machine transport must not spend an unrelated probe cutoff.
      // Keep both daemons' projection/authorization owners real beneath it.
      let hubAnswered = () => {};
      let releaseReply = () => {};
      const answered = new Promise<void>(resolve => { hubAnswered = resolve; });
      const replyReleased = new Promise<void>(resolve => { releaseReply = resolve; });
      transport.call.mockClear();
      transport.call.mockImplementationOnce(async input => {
        // Delay the hub's genuine Home target-read boundary, so the test also
        // rejects a shorter cutoff hidden inside current-only hub projection.
        onTargetRead = async () => { hubAnswered(); await replyReleased; };
        const response = await callHub(input);
        onTargetRead = () => {};
        input.signal?.throwIfAborted();
        return response;
      });
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const admission = createRuntimeProviderSpawnAuthorizationAttempt({
        selection: SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1, ref: {
          agentTargetKey: fixture.agentTargetKey, providerConnectionId: 'run-gateway', modelId: 'gateway-model',
        } }),
        machineId: peerId, agentTargetKey: fixture.agentTargetKey, agentId: fixture.agentId,
        lease: fixture.lease, getAccountSettingsSnapshot: snapshot,
        resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
        readModelProjection: createAccountScopedProviderModelProjectionReader({
          serverUrl: 'https://home.example.test', readCredentials: async () => credentials,
          readAccountSettingsSnapshot: async () => snapshot(),
          isCurrent: () => getActiveAccountSettingsSnapshot()?.scopeKey === snapshot().scopeKey,
        }),
        materializationBaseDir: join(homeDir, 'spawn-materialization'),
      });
      try {
        await Promise.race([answered, admission.then(result => {
          if (!result.ok) throw new Error(`Peer admission refused before its hub read: ${result.error.code}`);
        })]);
        await vi.advanceTimersByTimeAsync(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs + 5_000);
        releaseReply();
        const admitted = await admission;
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
        expect(transport.call).toHaveBeenCalledTimes(1);
        if (admitted.ok) {
          expect(admitted.attempt.isAuthorizationCurrent()).toBe(true);
          const authorization = admitted.attempt.authorization;
          // Runner preparation reauthorizes the admitted selection through the
          // same owner as a live same-binding model change. It must reach the
          // selected hub even though the worker has no local catalog observation.
          const prepared = await authorizeSessionModelTransitionProviderTargetWithLease({
            sessionId: 'peer-session', machineId: peerId, agentId: fixture.agentId,
            agentTargetKey: fixture.agentTargetKey, lease: fixture.lease,
            input: { selection: { agentTargetKey: fixture.agentTargetKey,
              providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'gateway-model' },
              activeSelection: { agentTargetKey: fixture.agentTargetKey,
                providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'gateway-model' },
              activeSessionBindingMetadata: authorization.sessionBindingMetadata,
              managedPurposeBindingSnapshot: authorization.sessionBindingMetadata.managedPurposeBindings },
          });
          expect(prepared.runtimeBindingBasis.deployment).toMatchObject({ kind: 'managedLocal',
            gatewayPlacement: { kind: 'machine', machineId: fixture.machineId } });
          expect(prepared.model.id).toBe('gateway-model');
          expect(transport.call.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toHaveLength(2);
          admitted.attempt.cleanupOnFailure();
        }
      } finally {
        releaseReply();
        await admission;
        vi.useRealTimers();
      }
      transport.call.mockImplementationOnce(async input => {
        const reply = DaemonProviderProbeResponseV1Schema.parse(await callHub(input));
        return reply.status === 'success' ? { ...reply, requestFingerprint: createProviderProbeRequestFingerprintV1({
          method: 'GET', endpointUrl: 'https://different-provider.invalid/v1', path: '/models', parser: 'openai-models', publicHeaders: {},
        }) } : reply;
      });
      expect(await peer.probe(request)).toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
      transport.call.mockImplementationOnce(async input => {
        const reply = DaemonProviderModelsResponseV1Schema.parse(await callHub(input));
        return reply.status === 'success' ? { ...reply, connectionRevision: reply.connectionRevision + 1 } : reply;
      });
      expect(await peer.models(request)).toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
      transport.call.mockImplementationOnce(async input => {
        const reply = await callHub(input);
        expect(await setEnabled(false)).toMatchObject({ status: 'success' });
        return reply;
      });
      expect(await peer.probe(request)).toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
      transport.call.mockClear();
      expect(await peer.probe(request)).toMatchObject({ status: 'error', error: { code: 'provider_not_enabled_on_machine' } });
      expect(transport.call).not.toHaveBeenCalled();
      expect(await setEnabled(true)).toMatchObject({ status: 'success' });
      expect(await peer.probe(request)).toMatchObject({ status: 'success', models: [{ id: 'gateway-model' }] });
      const projection = await projectPeerModels();
      expect(projection, JSON.stringify(projection)).toMatchObject({ status: 'success',
        groups: [{ connectionId: 'run-gateway', authorization: { authorized: true },
          rows: expect.arrayContaining([expect.objectContaining({ descriptor: expect.objectContaining({ id: 'gateway-model' }) })]) }],
      });
      expect(projection.status === 'success' ? projection.refreshFailures ?? [] : []).toEqual([]);
      expect(await peerModels.projectModels({ machineId: peerId, agentTargetKey: fixture.agentTargetKey }))
        .toMatchObject({ status: 'success', groups: [], hiddenSources: [{ connectionId: 'run-gateway',
          modelCount: projection.status === 'success' ? projection.groups[0]!.rows.length : 0 }] });
      expect(await peerModels.projectModels({ machineId: peerId, agentTargetKey: fixture.agentTargetKey,
        favoriteSelections: [{ agentTargetKey: fixture.agentTargetKey, providerConnectionId: request.connectionId, modelId: 'gateway-model' }] }))
        .toMatchObject({ status: 'success', groups: [{ connectionId: 'run-gateway', rows: [{ descriptor: { id: 'gateway-model' } }] }] });
      transport.call.mockImplementationOnce(async input => {
        const reply = DaemonProviderModelProjectionResponseV1Schema.parse(await callHub(input));
        return reply.status === 'success' ? { ...reply, groups: reply.groups.map(group => ({
          ...group, connectionRevision: group.connectionRevision + 1,
        })) } : reply;
      });
      expect(await projectPeerModels()).toMatchObject({ status: 'success', groups: [],
        refreshFailures: [{ error: { code: 'provider_authorization_changed' } }] });
      transport.call.mockImplementationOnce(async input => {
        const reply = await callHub(input);
        expect(await setEnabled(false)).toMatchObject({ status: 'success' });
        return reply;
      });
      expect(await projectPeerModels()).toMatchObject({ status: 'success', groups: [],
        refreshFailures: [{ error: { code: 'provider_authorization_changed' } }] });
      transport.call.mockClear();
      expect(await projectPeerModels()).toMatchObject({ status: 'success', groups: [],
        refreshFailures: [{ error: { code: 'provider_not_enabled_on_machine' } }] });
      expect(transport.call).not.toHaveBeenCalled();
      expect(await setEnabled(true)).toMatchObject({ status: 'success' });
      expect(await projectPeerModels()).toMatchObject({ status: 'success',
        groups: [{ connectionId: 'run-gateway', authorization: { authorized: true } }] });
      await exerciseGatewayStreamJourney({ fixture, upstream, snapshot: () => {
        const active = getActiveAccountSettingsSnapshot();
        if (!active) throw new Error('Expected current Account owner snapshot');
        return active;
      }, hubModels, peerId, setEnabled,
        deliverPending: async send => {
          const nativeFetch = globalThis.fetch;
          // Readiness observes public features; Session compatibility reads the
          // authenticated projection. Both are the same controlled Home here.
          vi.stubGlobal('fetch', ((url, init) => ['/v1/features', '/v1/features/authenticated'].includes(new URL(String(url)).pathname)
            ? Promise.resolve(new Response(JSON.stringify({ features: {}, capabilities: { session: {
              runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 }, publisherAuthority: { protocolVersion: 1 },
            } } }), { status: 200, headers: { 'content-type': 'application/json' } })) : nativeFetch(url, init)) satisfies typeof fetch);
          let claims = 0;
          const activityHome = createSessionRuntimeActivityHomeStub({ machineId: fixture.machineId });
          const transcriptHome = createSessionTranscriptHomeStub();
          const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
            const homeAnswer = activityHome.answer(event, payload) ?? transcriptHome.answer(event, payload);
            if (homeAnswer !== null) return homeAnswer;
            if (event !== 'pending-materialize-next') return resolveApiSessionSocketDefaultAck(event, payload);
            claims += 1;
            return { ok: true, didMaterialize: true, didWrite: false, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2,
              deliveryState: { mode: 'provider', unresolved: true }, message: { id: null, seq: null, localId: 'fresh-original',
                messageRole: 'user', providerAction: 'send', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'pending-fresh' },
                  meta: { source: 'ui' } } }, createdAt: 1, updatedAt: 1 } };
          } });
          bindApiSessionSocketPairMock(socketBoundary.io, { sessionSocket: socket, userSocket: createApiSessionSocketStub(), fallbackSocket: socket });
          const client = createTestApiSessionClient(ApiSessionClient, credentials.token,
            createMockSession({ id: 'main-two', encryptionMode: 'plain', pendingCount: 1, pendingVersion: 1 }),
            { localMachineId: fixture.machineId, durableMutationDeliveryInitiallyActive: false });
          const queue = new MessageQueue2<{ id: string }>(() => 'mode');
          client.onUserMessage(message => queue.pushImmediate(message.content.text, { id: 'mode' }));
          const consumer = createSessionProviderInputConsumer({ messageQueue: queue, refreshBeforeQueuedBatch: false, reconcileWhenEmpty: 'skip',
            session: { waitForMetadataUpdate: signal => client.waitForMetadataUpdate(signal), getMetadataSnapshot: () => client.getMetadataSnapshot(),
              materializeNextPendingMessageSafely: options => client.materializeNextPendingMessageSafely(options),
              hasPendingProviderInput: () => client.hasPendingProviderInput(),
              reconcilePendingProviderInputCustodyBeforeMaterialization: () => client.reconcilePendingProviderInputCustodyBeforeMaterialization() } });
          const stop = new AbortController();
          try {
            if (!Reflect.get(client, 'sessionSyncPendingInputServerContractResult')) {
              await new Promise<void>(resolve => client.once('session-sync-server-contract', resolve));
            }
            expect(Reflect.get(client, 'sessionSyncPendingInputServerContractResult')).toMatchObject({ pendingInputProtocolVersion: 1 });
            const batch = await consumer.waitForNextInput({ abortSignal: stop.signal });
            expect(batch?.message).toBe('pending-fresh');
            if (!batch) throw new Error('Expected retained Pending input');
            await send(batch.message);
            expect(claims).toBe(1); expect(queue.size()).toBe(0);
            expect(client.hasPendingProviderInput('fresh-original')).toBe(true);
          } finally { stop.abort(); await client.close(); vi.unstubAllGlobals(); }
        } });
      const ownedSnapshot = getActiveAccountSettingsSnapshot();
      resetActiveAccountSettingsSnapshotForTests();
      expect(await peerModels.projectModelsForAccount({ machineId: peerId, agentTargetKey: fixture.agentTargetKey,
        sourceConnectionId: 'run-gateway', mode: 'management' }, {
        getAccountSettingsSnapshot: () => ownedSnapshot,
        resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
        signal: new AbortController().signal, isCurrent: () => true,
      })).toMatchObject({ status: 'success', groups: [{ connectionId: 'run-gateway', authorization: { authorized: true } }] });
    } finally { await upstream.close(); await fixture.cleanup(); }
  }), 300_000);
