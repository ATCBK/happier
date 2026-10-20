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

const transport = vi.hoisted(() => ({ call: vi.fn<typeof callExactMachineRpc>() }));
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

it('honours a committed peer grant on the next probe and model read through its selected hub', () =>
  withConfiguredDaemonTestHome({ prefix: 'gateway-catalog-peer-' }, async ({ homeDir }) => {
    let onTargetRead: () => void | Promise<void> = () => {};
    let pool = { generation: 1, policy: { autoSwitch: false } };
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller: createPluginReloadController(), physicalGateway: true, probeCatalog: true,
      catalogModels: [{ id: 'gateway-model' }],
      resolveAccountTarget: async (target, signal) => {
        signal.throwIfAborted();
        await onTargetRead();
        return { account: target.kind === 'account' ? target.account
          : { service: target.service, accountId: 'upstream-account' }, displayName: 'Upstream',
          ...(target.kind === 'group' ? { group: { groupId: target.groupId, generation: pool.generation } } : {}) };
      },
    });
    try {
      if (!fixture.gateway) throw new Error('Expected physical gateway');
      const peerId = 'peer-worker';
      const credentials = { token: 'gateway-catalog-account', encryption: null };
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
      transport.call.mockImplementation(async ({ machineId, method, request, signal }) => {
        expect(machineId).toBe(fixture.machineId);
        if (method === RPC_METHODS.DAEMON_PROVIDERS_PROBE) return DaemonProviderProbeResponseV1Schema.parse(await hub.probe(request, 'manual_refresh', { signal }));
        if (method === 'daemon.providers.models') return DaemonProviderModelsResponseV1Schema.parse(await hub.models(request));
        if (method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION) return DaemonProviderModelProjectionResponseV1Schema.parse(await hubModels.projectModels(DaemonProviderModelProjectionRequestV1Schema.parse(request)));
        throw new Error('Unexpected hub RPC');
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
        await answered;
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
      const ownedSnapshot = getActiveAccountSettingsSnapshot();
      resetActiveAccountSettingsSnapshotForTests();
      expect(await peerModels.projectModelsForAccount({ machineId: peerId, agentTargetKey: fixture.agentTargetKey,
        sourceConnectionId: 'run-gateway', mode: 'management' }, {
        getAccountSettingsSnapshot: () => ownedSnapshot,
        resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
        signal: new AbortController().signal, isCurrent: () => true,
      })).toMatchObject({ status: 'success', groups: [{ connectionId: 'run-gateway', authorization: { authorized: true } }] });
    } finally { await fixture.cleanup(); }
  }));
