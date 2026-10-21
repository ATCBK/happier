import { access } from 'node:fs/promises';
import axios from 'axios';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, ProviderConnectionIdSchema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { DaemonProviderModelProjectionRequestV1Schema, DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { createProviderOperationLifetime } from '@/providers/operationLifetime';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { createRuntimeProviderModelManagementServices } from './runtimeServices';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMachineSharedProviderGatewayResolver } from '@/daemon/machine/bootstrapMachineSyncRuntime';
import { createRuntimeProviderServices } from '@/providers/probe/runtimeServices';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { logger } from '@/ui/logger';

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); });

it('reports missing packaged Agent factory activation as internal failure in both projection and launch', async () => {
  const fixture = await createManagedRunLaunchFixture({ activateAgent: false, sessionRunnerFactoryModule: './missingFactory.mjs' });
  const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  try {
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      getAccountSettingsSnapshot: () => fixture.snapshot, featureGate: { isEnabled: () => true },
      acquireRuntimeLease: async () => fixture.lease,
      modelSettingsMutation: async (): Promise<never> => { throw new Error('No mutation during projection'); } });
    await expect(services.projectModels({ machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'agent_error' } });
    expect(diagnostic).toHaveBeenCalledWith('[PROVIDER] Unexpected failure', expect.objectContaining({
      operation: 'model_projection', errorType: 'Error',
      sourceLocations: expect.arrayContaining([expect.stringMatching(/adapter\.ts:\d+:\d+/)]),
    }));
    const result = await createRuntimeProviderSpawnAuthorizationAttempt({
      selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'model-a' } },
      machineId: fixture.machineId, agentId: fixture.agentId, agentTargetKey: fixture.agentTargetKey,
      lease: fixture.lease, getAccountSettingsSnapshot: () => fixture.snapshot,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'agent_error' } });
    expect(fixture.lease.registry.agentRuntimesByAgentId.has(fixture.agentId)).toBe(false);
  } finally { await fixture.cleanup(); }
});

it('admits a cold peer catalog through the real hub projection before optional history cleanup', () => withConfiguredDaemonTestHome({ prefix: 'cold-peer-catalog-' }, async ({ homeDir }) => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true, probeCatalog: true,
    directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
    controller: pluginReloadController, catalogModels: [{ id: 'peer-only-probed', connectedAccountPurposes: [{
      consumer: { pluginId: 'acme.shared-registry', localId: 'gateway' }, purpose: 'upstream',
    }] }],
  });
  try {
    if (!fixture.gateway || typeof fixture.lease.registry.generation !== 'number') throw new Error('Expected managed gateway registry');
    const peerMachineId = 'peer-worker';
    const base = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
      connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
        gatewayPlacement: { kind: 'machine', machineId: fixture.machineId } })),
    });
    const connection = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
      providerSettings: base, registry: fixture.contributes, dnsEvidenceByEndpointUrl: new Map() });
    if (connection.status !== 'resolved') throw new Error('Expected exact hub connection');
    const settings = ProviderSettingsV1Schema.parse({ ...base, machineGrants: [peerMachineId, fixture.machineId].map(machineId => ({
      v: 1, connectionId: 'run-gateway', machineId, confirmedAt: 1,
      connectionSecurityFingerprint: connection.record.connectionSecurityFingerprint,
      endpointSetFingerprint: connection.record.endpointSetFingerprint,
    })) });
    const snapshot = { ...fixture.snapshot, providerConnectionsCatalog: {
      status: 'ready' as const, revision: 2, catalog: splitProviderSettingsV1(settings).catalog,
    } };
    const probes = createRuntimeProviderServices({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
      featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => snapshot,
      registry: resolveProviderContributionRegistryView(fixture.lease.registry.contributes,
        fixture.lease.registry.generation, fixture.lease.registry.readPluginOccurrenceId),
      resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId: fixture.machineId,
        readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId: fixture.machineId }) }),
      resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
    });
    const probed = await probes.probe({ connectionId: 'run-gateway', machineId: fixture.machineId });
    expect(probed, JSON.stringify(probed)).toMatchObject({ status: 'success', models: [{ id: 'peer-only-probed' }] });
    const hubModels = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: () => snapshot,
      acquireRuntimeLease: async () => {
        const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected canonical hub registry lease');
        return lease;
      },
      resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
      modelSettingsMutation: async (): Promise<never> => { throw new Error('No model mutations during admission'); },
    });
    const modelSelection = { v: 1 as const, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey,
      providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'peer-only-probed' } };
    // A peer's invocation starts with no Provider row loaded. Exercise the real
    // catalog store, publication and remote hub projection while the Home's
    // optional history maintenance remains pending at its HTTP boundary.
    const { providerConnectionsCatalog: _catalog, ...coldSnapshot } = snapshot;
    const operationContext = createInvocationSavedSecretOperationContextV1({
      credentials: { token: 'run-account', encryption: null }, snapshot: coldSnapshot,
      serverHttpBaseUrl: 'https://peer-catalog-home.invalid', isCurrent: async () => true,
    });
    let enterHistory = () => {};
    let releaseHistory = () => {};
    const historyEntered = new Promise<void>(resolve => { enterHistory = resolve; });
    const historyReleased = new Promise<void>(resolve => { releaseHistory = resolve; });
    const originalGet = axios.get.bind(axios);
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const endpoint = new URL(String(url));
      if (endpoint.origin !== operationContext.serverHttpBaseUrl) return originalGet(url, config);
      if (endpoint.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (endpoint.pathname === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
        status: 'present', revision: 2, content: { t: 'plain', v: snapshot.providerConnectionsCatalog.catalog },
      } };
      if (endpoint.pathname === '/v2/account/settings') return { status: 200, data: {
        version: 1, content: { t: 'plain', v: {} },
      } };
      if (endpoint.pathname === '/v2/account/settings/history') {
        enterHistory(); await historyReleased;
        return { status: 200, data: { snapshots: [] } };
      }
      const history = emptyAccountSettingsHistoryCaptureResponse(endpoint.pathname);
      if (history) return history;
      throw new Error(`Unexpected peer catalog HTTP boundary: ${endpoint.pathname}`);
    });
    let coldPreparation: Promise<Awaited<ReturnType<typeof createRuntimeProviderSpawnAuthorizationAttempt>>> | undefined;
    let projectedOnHub = false;
    try {
      let coldAdmission: Awaited<ReturnType<typeof createRuntimeProviderSpawnAuthorizationAttempt>> | undefined;
      coldPreparation = createRuntimeProviderSpawnAuthorizationAttempt({
        selection: modelSelection, machineId: peerMachineId, agentTargetKey: fixture.agentTargetKey,
        agentId: fixture.agentId, lease: fixture.lease,
        getAccountSettingsSnapshot: operationContext.readSnapshot, savedSecretOperationContext: operationContext,
        materializationBaseDir: fixture.happyHomeDir,
        resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
        readModelProjection: async request => {
          expect(request.machineId).toBe(fixture.machineId);
          const response = await hubModels.projectModels(request);
          DaemonProviderModelProjectionResponseV1Schema.parse(response);
          projectedOnHub = true;
          return response;
        },
      }).then(result => { coldAdmission = result; return result; });
      await historyEntered;
      await vi.waitFor(() => expect(coldAdmission, JSON.stringify(coldAdmission)).toMatchObject({ ok: true }));
      expect(projectedOnHub).toBe(true);
      expect(operationContext.readSnapshot()?.providerConnectionsCatalog).toMatchObject({ status: 'ready', revision: 2 });
    } finally {
      releaseHistory();
      try {
        const result = await coldPreparation;
        if (result?.ok) result.attempt.cleanupOnFailure();
        await vi.waitFor(() => expect(operationContext.readSnapshot()?.providerConnectionsCatalog)
          .toMatchObject({ status: 'ready', cleanup: { status: 'complete' } }));
      } finally { http.mockRestore(); }
    }
  } finally { await fixture.cleanup(); }
}));

it.each(['purpose', 'dns', 'selected'] as const)('retains healthy models and scopes slow source work (%s)', async slowBoundary => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true, probeCatalog: false });
  let releaseTarget = () => {};
  try {
    if (!fixture.gateway || typeof fixture.lease.registry.generation !== 'number') throw new Error('Expected managed fixture');
    const registry = resolveProviderContributionRegistryView(fixture.lease.registry.contributes,
      fixture.lease.registry.generation, fixture.lease.registry.readPluginOccurrenceId);
    const base = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings,
      connections: [...fixture.providerSettings.connections, {
        v: 1, id: 'healthy', role: 'named', displayName: 'Healthy', displayNameMode: 'custom',
        revision: 1, createdAt: 1, updatedAt: 1,
        source: { kind: 'custom', template: { v: 1, name: 'Healthy', endpointTemplates: [{
          id: 'responses', protocol: 'openai-responses', baseUrl: 'https://1.1.1.1/v1',
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
        }], catalog: { source: 'manual', manualModelPolicy: 'allowed' } } },
      }],
      manualModelsByConnectionId: { ...fixture.providerSettings.manualModelsByConnectionId, healthy: [{ id: 'healthy-model', addedAt: 1 }] },
    });
    const healthy = resolveProviderConnectionForMachine({ connectionId: 'healthy', machineId: fixture.machineId,
      providerSettings: base, registry, dnsEvidenceByEndpointUrl: new Map([['https://1.1.1.1/v1', ['1.1.1.1']]]) });
    if (healthy.status !== 'resolved') throw new Error('Expected healthy source');
    const settings = ProviderSettingsV1Schema.parse({ ...base, accountGrants: [...base.accountGrants, {
      v: 1, connectionId: 'healthy', connectionSecurityFingerprint: healthy.record.connectionSecurityFingerprint, confirmedAt: 1,
    }] });
    if (slowBoundary === 'dns') {
      const slow = settings.connections.find(connection => connection.id === 'healthy');
      if (!slow || slow.source.kind !== 'custom') throw new Error('Expected custom source');
      settings.connections.push({ ...slow, id: ProviderConnectionIdSchema.parse('slow-dns'), source: { ...slow.source, template: {
        ...slow.source.template, endpointTemplates: slow.source.template.endpointTemplates.map(endpoint => ({
          ...endpoint, baseUrl: 'https://slow.example/v1',
        })),
      } } });
    }
    const { catalog, defaults } = splitProviderSettingsV1(settings);
    const snapshot = { ...fixture.snapshot,
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
      providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog },
    };
    let targetEntered = () => {};
    const entered = new Promise<void>(resolve => { targetEntered = resolve; });
    const released = new Promise<void>(resolve => { releaseTarget = resolve; });
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected mutation'); };
    // The Home target lookup is the external boundary. Keep purpose validation,
    // registry activation, catalog assembly and the strict response consumer real.
    const purposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async (target, signal) => {
        if (slowBoundary !== 'dns') { targetEntered(); await released; }
        signal.throwIfAborted();
        return target.kind === 'account' ? { account: target.account, displayName: 'Upstream' } : null;
      },
    });
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      happyHomeDir: fixture.happyHomeDir, registry, getAccountSettingsSnapshot: () => snapshot,
      featureGate: { isEnabled: () => true }, resolveAddresses: async hostname => {
        if (hostname === 'slow.example') { targetEntered(); await released; }
        return ['1.1.1.1'];
      },
      acquireRuntimeLease: async () => {
        const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected canonical lease');
        return lease;
      },
      resolveManagedPurposeBindingIntent: purposes.resolveBindingIntent, modelSettingsMutation: unexpected,
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = services.projectModels(DaemonProviderModelProjectionRequestV1Schema.parse({ machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey,
      refreshPolicy: 'current_only', mode: 'management',
      ...(slowBoundary === 'selected' ? { sourceConnectionId: 'healthy' } : {}),
    })).then(result => { settled = true; return result; });
    if (slowBoundary !== 'selected') {
      await entered;
      // Let the healthy source complete its real filesystem/catalog work while
      // only the unrelated Home/DNS boundary remains held.
      await new Promise<void>(resolve => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs);
    }
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
      const result = DaemonProviderModelProjectionResponseV1Schema.parse(await pending);
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'success', groups: expect.arrayContaining([expect.objectContaining({ connectionId: 'healthy', rows: [expect.objectContaining({
        ref: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: 'healthy', modelId: 'healthy-model' },
      })] })]) });
      if (result.status !== 'success') throw new Error('Expected partial projection');
      expect(result.refreshFailures).toEqual(slowBoundary === 'selected' ? undefined : [{
        connectionId: slowBoundary === 'dns' ? 'slow-dns' : 'run-gateway',
        error: expect.objectContaining({ code: 'provider_endpoint_unavailable' }),
      }]);
    } finally {
      vi.useRealTimers();
      releaseTarget();
      await pending;
    }
  } finally {
    vi.useRealTimers();
    releaseTarget();
    await fixture.cleanup();
  }
});

it.each([true, false])('G1 projects only the owning Account source and purpose without ambient fallback or refresh (probe catalog: %s)', async probeCatalog => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true, probeCatalog });
  try {
    if (!fixture.gateway) throw new Error('Expected physical gateway fixture');
    if (typeof fixture.lease.registry.generation !== 'number') throw new Error('Expected authoritative registry generation');
    const registry = resolveProviderContributionRegistryView(fixture.lease.registry.contributes,
      fixture.lease.registry.generation, fixture.lease.registry.readPluginOccurrenceId);
    const ambientSettings = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
      connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
        displayName: 'Ambient Gateway', displayNameMode: 'custom',
        purposeBindingDefaults: { upstream: { kind: 'account', account: {
          service: { pluginId: fixture.gateway!.pluginId, localId: 'accounts' }, accountId: 'ambient-upstream',
        } } },
      })),
    });
    const ambientResolution = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
      providerSettings: ambientSettings,
      registry, dnsEvidenceByEndpointUrl: new Map() });
    if (ambientResolution.status !== 'resolved') throw new Error('Expected ambient connection');
    const admittedAmbientSettings = ProviderSettingsV1Schema.parse({ ...ambientSettings, machineGrants: [{ v: 1,
      connectionId: 'run-gateway', machineId: fixture.machineId, confirmedAt: 1,
      connectionSecurityFingerprint: ambientResolution.record.connectionSecurityFingerprint,
      endpointSetFingerprint: ambientResolution.record.endpointSetFingerprint,
    }] });
    const { catalog, defaults } = splitProviderSettingsV1(admittedAmbientSettings);
    const ambientSnapshot = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken('ambient-account'),
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
      providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog },
    };
    setActiveAccountSettingsSnapshot(ambientSnapshot);
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected account materialization'); };
    // Account transport truth is the boundary. Purpose validation remains the
    // real owner and refuses the other Account's upstream binding.
    const ambientPurposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async (target, signal) => {
        signal.throwIfAborted();
        return target.kind === 'account' && target.account.accountId === 'ambient-upstream'
          ? { account: target.account, displayName: 'Ambient upstream' } : null;
      },
    });
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
      acquireRuntimeLease: async () => {
        const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected canonical registry lease');
        return lease;
      },
      resolveManagedPurposeBindingIntent: ambientPurposes.resolveBindingIntent,
      modelSettingsMutation: unexpected,
    });
    const request = DaemonProviderModelProjectionRequestV1Schema.parse({ machineId: fixture.machineId,
      agentTargetKey: fixture.agentTargetKey, mode: 'management', sourceConnectionId: 'run-gateway', refreshPolicy: 'current_only' });
    const ambient = await services.projectModels(request);
    expect(ambient, JSON.stringify(ambient)).toMatchObject({ status: 'success', groups: [{ connectionId: 'run-gateway', connectionName: 'Ambient Gateway',
      sourceAuthority: { connectionSecurityFingerprint: ambientResolution.record.connectionSecurityFingerprint },
      rows: [{ descriptor: { id: 'example' } }],
    }] });
    const admittedAmbient = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
      providerSettings: admittedAmbientSettings, registry, dnsEvidenceByEndpointUrl: new Map() });
    if (admittedAmbient.status !== 'resolved') throw new Error('Expected admitted ambient connection');
    await expect(services.summary({ connectionId: 'run-gateway', machineId: fixture.machineId,
      accountSettings: ambientSnapshot.settings, providerSettings: admittedAmbientSettings, registry,
      dnsEvidence: new Map(), resolution: admittedAmbient,
      lifetime: createProviderOperationLifetime({ wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs }),
    })).resolves.toMatchObject({ status: 'success' });

    const controller = new AbortController();
    let current = true;
    const context = { getAccountSettingsSnapshot: () => fixture.snapshot,
      resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
      signal: controller.signal, isCurrent: async () => current };
    const owned = await services.projectModelsForAccount({ ...request, forceRefresh: true, refreshPolicy: undefined }, context);
    expect(owned).toMatchObject({ status: 'success', groups: [{ connectionId: 'run-gateway', connectionName: 'Gateway',
      sourceAuthority: { connectionSecurityFingerprint: fixture.connectionSecurityFingerprint },
      rows: [{ descriptor: { id: 'example' } }],
    }] });
    expect(owned).not.toEqual(ambient);
    await expect(access(join(fixture.gateway.directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(services.projectModelsForAccount(request, { ...context, getAccountSettingsSnapshot: () => null }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_settings_invalid' } });
    current = false;
    await expect(services.projectModelsForAccount(request, context))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    current = true;
    let releaseTransport = () => {};
    let transportStarted = () => {};
    const entered = new Promise<void>(resolve => { transportStarted = resolve; });
    const released = new Promise<void>(resolve => { releaseTransport = resolve; });
    const pausedPurposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async (target, signal) => {
        transportStarted();
        await released;
        signal.throwIfAborted();
        return target.kind === 'account' ? { account: target.account, displayName: 'Owning upstream' } : null;
      },
    });
    const pending = services.projectModelsForAccount(request, {
      ...context, resolveManagedPurposeBindingIntent: pausedPurposes.resolveBindingIntent,
    });
    await entered;
    current = false;
    releaseTransport();
    await expect(pending).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
  } finally { await fixture.cleanup(); }
});
