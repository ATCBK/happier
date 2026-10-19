import axios from 'axios';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS, ProviderConnectionIdSchema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { DaemonProviderModelsResponseV1Schema, DaemonProviderProbeResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createProviderProbeRequestFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import * as persistence from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createMachineSharedProviderGatewayResolver } from '@/daemon/machine/bootstrapMachineSyncRuntime';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderConnectionServices } from '@/providers/connections/runtimeServices';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
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
    let onTargetRead = () => {};
    let pool = { generation: 1, policy: { autoSwitch: false } };
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller: createPluginReloadController(), physicalGateway: true, probeCatalog: true,
      catalogModels: [{ id: 'gateway-model' }],
      resolveAccountTarget: async (target, signal) => {
        signal.throwIfAborted();
        onTargetRead();
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
      transport.call.mockImplementation(async ({ machineId, method, request, signal }) => {
        expect(machineId).toBe(fixture.machineId);
        if (method === RPC_METHODS.DAEMON_PROVIDERS_PROBE) return DaemonProviderProbeResponseV1Schema.parse(await hub.probe(request, 'manual_refresh', { signal }));
        if (method === 'daemon.providers.models') return DaemonProviderModelsResponseV1Schema.parse(await hub.models(request));
        throw new Error('Unexpected hub RPC');
      });
      const peer = createRuntimeProviderServices({ machineId: peerId, happyHomeDir: homeDir,
        featureGate: { isEnabled: () => true }, registry: fixture.contributes,
        resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
      });
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
    } finally { await fixture.cleanup(); }
  }));
