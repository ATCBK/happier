import axios from 'axios';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderConnectionIdSchema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { ProviderModelBindingSourceV1Schema, ProviderModelConfirmationSourceV1Schema } from '@happier-dev/protocol/providers/binding-compatibility';
import { setProviderExperimentalConfirmationV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { getProviderExperimentalConfirmationCatalogSourceKeyV1 } from '@happier-dev/protocol/providers/settings/v1';
import type { TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { openSessionTeamCredentialProviderBinding } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { resolveTeamCredentialModelCompatibility } from '@/providers/broker/teamCredentialModelCompatibility';
import { PROVIDER_BROKER_ENDPOINT_PATH_HEADER, PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH } from '@/providers/broker/providerBrokerPrivateProtocol';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
// Parse the real broker producer with the exact plugin-open consumer, not a
// test copy of the Codex engine-config schema. No production private import.
import { parseCodexProviderBindingEngineConfigV1 } from '../../../../../packages/plugins/codex/src/agent/providerBinding/runtimeConfig';
import { configuration } from '@/configuration';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { openCurrentRunnerTeamCredentialProviderBinding } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { logger } from '@/ui/logger';

const nativeFetch = fetch;
const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null, port: 0,
  responseStatus: 0, responseBody: null as unknown }));
// Keep the real control app/dispatcher; only its OS listener uses an ephemeral port.
vi.mock('@/daemon/controlServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    const app = actual.createDaemonControlApp(input);
    app.addHook('onSend', async (request, reply, payload) => {
      if (request.url === AGENT_RUNTIME_DAEMON_SERVICES_PATH && typeof payload === 'string') {
        boundary.responseStatus = reply.statusCode;
        boundary.responseBody = JSON.parse(payload);
      }
      return payload;
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing private listener');
    boundary.port = address.port;
    return { port: address.port, stop: () => app.close() };
  } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); boundary.control = null; });

it.each(['ready', 'missing declaration', 'non-204', 'socket closed', 'refresh refused'] as const)(
  'opens the real Codex Team binder with the tracked recipient catalog, never custodian consent (%s)', async metadata => {
  let h: Awaited<ReturnType<typeof createInstalledProjectAgentDaemonFixture>>;
  let model: TeamCredentialProviderModelCatalogEntryV1;
  let brokerOpens = 0;
  let refreshStream: (() => Promise<unknown>) | undefined;
  const warnings = vi.spyOn(logger, 'warnLocalFile');
  h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'codex', false, undefined, undefined, {
    openTeamCredentialProviderBinding: async input => {
      const opened = await openSessionTeamCredentialProviderBinding({ ...input, machineId: 'machine',
        binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: input.resourceId, expectedResourceRevision: input.expectedResourceRevision,
          deliveryMode: input.deliveryMode, teamId: input.teamId }, lease: h.plugin.lease,
        materializationBaseDir: join(h.f.directory, 'materialized'), readCatalog: async () => [model],
        openBroker: async request => {
          brokerOpens++;
          if (request.refreshAuthority && metadata === 'refresh refused') return { ok: false, reasonCode: 'broker_unavailable' };
          return { ok: true, target: { custodianAccountId: 'source-owner', brokerMachineId: 'broker', endpointId: 'b'.repeat(64),
            endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } }, authority: { payload: { v: 1,
              aud: 'happier-provider-broker-route-v1', grantId: 'grant', issuedAt: 1, expiresAt: 2,
              teamId: 'team', resourceId: request.resourceId, sourceRevision: request.sourceRevision,
              brokerPlacementFingerprint: 'c'.repeat(64), initiatorTokenEpoch: 0,
              initiator: { accountId: 'requester', machineId: 'machine', endpointId: 'a'.repeat(64) },
              target: { custodianAccountId: 'source-owner', machineId: 'broker', endpointId: 'b'.repeat(64) },
              consumer: request.consumer, application: request.application },
              signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'A'.repeat(86) } } };
        },
        openTunnel: async ({ refreshBrokerOpen }) => {
          refreshStream = refreshBrokerOpen;
          return { localPort: 43123, localCapability: 'synthetic-consumer-token', observedPath: 'direct',
            retire: async () => undefined, close: async () => undefined };
        },
      });
      if (!opened) throw new Error('Expected Team binding');
      return opened;
    },
  });
  const identity = h.plugin.registry.contributes.agentDefinitionsById.get('codex')?.identity;
  if (!identity) throw new Error('Missing admitted Codex identity');
  const agentTargetKey = `agent:${identity.pluginId}/${identity.localId}`;
  model = {
    selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team', expectedResourceRevision: 2,
      deliveryMode: 'brokered', agentTargetKey, modelId: 'gpt-5.6-luna' },
    descriptor: { id: 'gpt-5.6-luna', name: 'Luna' }, sourceRevision: 'source-2', availability: 'available',
    application: { agentTargetKey, implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'responses', protocol: 'openai-responses' },
    sourceFacts: ProviderModelBindingSourceV1Schema.parse({ endpoint: { id: 'responses', protocol: 'openai-responses',
      capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } },
      compatibilityOverrides: [{ agentTargetKey, protocol: 'openai-responses', status: 'experimental', reason: 'Recipient-only consent' }] }),
    confirmationSource: ProviderModelConfirmationSourceV1Schema.parse({ connectionId: 'connected-source:team-pool',
      catalogSourceKey: getProviderExperimentalConfirmationCatalogSourceKeyV1({ connectionId: ProviderConnectionIdSchema.parse('connected-source:team-pool') }) }),
  };
  h.tracked.spawnOptions = { ...h.tracked.spawnOptions, teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' },
    resourceId: 'resource', expectedResourceRevision: 2, teamId: 'team', deliveryMode: 'brokered' }],
    modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: null, modelId: model.descriptor.id } } };
  const compatibility = await resolveTeamCredentialModelCompatibility({ lease: h.plugin.lease, agentId: 'codex',
    model: { ...model, deliveryMode: 'brokered' }, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1 });
  if (compatibility.result.status !== 'experimental' || !model.confirmationSource) throw new Error('Expected experimental Codex binding');
  const confirmed = setProviderExperimentalConfirmationV1(DEFAULT_PROVIDER_SETTINGS_V1, { ...model.confirmationSource, agentTargetKey,
    modelId: compatibility.result.confirmationScope.kind === 'model' ? model.descriptor.id : null,
    compatibilityFingerprint: compatibility.compatibilityFingerprint, confirmedAt: 1 });
  const snapshot = h.requester.readAccountSettingsSnapshot();
  if (!snapshot) throw new Error('Missing recipient snapshot');
  const ambient = { ...snapshot, scopeKey: 'custodian-account', providerConnectionsCatalog: {
    status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog } };
  setActiveAccountSettingsSnapshot(ambient);
  const get = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/entity-rows/provider-connections') {
      expect(options?.headers?.Authorization).toBe(`Bearer ${h.requester.bootstrap.credentials.token}`);
      return { status: 200, data: { status: 'present', revision: 2, content: { t: 'plain', v: splitProviderSettingsV1(confirmed).catalog } } };
    }
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    return get(url, options);
  });
  const fetchBoundary = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    const target = new URL(String(url));
    if (target.pathname === AGENT_RUNTIME_DAEMON_SERVICES_PATH && target.hostname === '127.0.0.1'
      && target.port === String(boundary.port)) return nativeFetch(url, options);
    if (target.pathname === PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH) {
      // Native transport is the boundary: a failed fresh handshake closes its
      // local HTTP socket without returning an HTTP response to the real binder.
      if (metadata === 'refresh refused') await refreshStream?.();
      if (metadata === 'socket closed' || metadata === 'refresh refused') {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
      }
      return new Response(null, { status: metadata === 'non-204' ? 403 : 204,
        headers: metadata === 'missing declaration' ? {} : { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1' } });
    }
    return fetchBoundary(url, options);
  });
  const open = () => h.dispatch({ kind: 'provider_broker.binding.open', requestId: 'recipient-team-open',
    resourceId: 'resource', expectedResourceRevision: 2, agentTargetKey, modelId: model.descriptor.id });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: configuration.happyHomeDir,
    publicReleaseRing: configuration.publicReleaseRing });
  // The bundled development Agent belongs to this real source runner root.
  h.runner.snapshotIdentity = `path:${resolve(__dirname, '../../..')}`;
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent };
  const published = await publishAgentRuntimeDaemonServiceAuthority({ ...authority,
    httpPort: boundary.port, capability: 'A'.repeat(43), readPluginHardRevocationRevision: async () => 0 });
  h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = path;
  h.tracked.agentRuntimeDaemonServiceCapabilityHash = published.capabilityDigest;
  const openThroughRunner = () => openCurrentRunnerTeamCredentialProviderBinding({ authority, operation: {
    kind: 'provider_broker.binding.open', resourceId: 'resource', expectedResourceRevision: 2,
    agentTargetKey, modelId: model.descriptor.id } });
  try {
  if (metadata !== 'ready') {
    const refused = await openThroughRunner().then(() => null, (error: unknown) => error);
    expect(brokerOpens).toBe(metadata === 'refresh refused' ? 2 : 1);
    expect(warnings.mock.calls).toContainEqual(['[ProviderBroker] Endpoint discovery refused', expect.objectContaining({
      reason: 'endpoint_discovery_failed',
      discoveryCause: metadata === 'refresh refused' ? 'broker_refresh_refused' : metadata === 'socket closed'
        ? 'socket_closed' : metadata === 'missing declaration' ? 'invalid_metadata' : 'http_response',
      discoveryElapsedMs: expect.any(Number),
      refreshOutcome: metadata === 'refresh refused' ? 'refused' : 'not_requested',
      ...(metadata === 'refresh refused' ? { refreshElapsedMs: expect.any(Number) } : {}),
      ...(metadata === 'socket closed' || metadata === 'refresh refused' ? {} : { httpStatus: metadata === 'non-204' ? 403 : 204 }),
    })]);
    const discoveryRecord = warnings.mock.calls.find(([label]) => label === '[ProviderBroker] Endpoint discovery refused')?.[1];
    if (metadata === 'socket closed' || metadata === 'refresh refused') expect(discoveryRecord).not.toHaveProperty('httpStatus');
    for (const privateValue of ['synthetic-consumer-token', 'source-owner', 'requester', 'other side closed']) {
      expect(JSON.stringify(discoveryRecord)).not.toContain(privateValue);
    }
    expect(boundary.responseStatus).toBe(200);
    expect(boundary.responseBody).toEqual({ ok: false,
      error: { code: 'provider_endpoint_unavailable', message: 'provider_endpoint_unavailable' } });
    expect(refused).toMatchObject({ code: 'provider_endpoint_unavailable', message: 'provider_endpoint_unavailable' });
    expect(readSessionPreparationFailureDiagnostic(refused)).toEqual({
      originalCode: 'provider_endpoint_unavailable', reason: 'unknown', contextSource: 'unknown' });
    return;
  }
  const opened = await openThroughRunner();
  expect(opened).toMatchObject({ kind: 'provider_broker.binding', status: 'opened',
    providerBinding: { source: { kind: 'team_resource', resourceId: 'resource', resourceRevision: 2 }, model: model.descriptor,
      upstream: { protocol: 'openai-responses', normalizedUrl: 'http://127.0.0.1:43123/v1', credential: 'apiKey' } } });
  const config = parseCodexProviderBindingEngineConfigV1(opened.providerBinding);
  if (!config) throw new Error('Expected Codex engine config');
  expect(config.config[`model_providers.${config.modelProvider}`]).toMatchObject({
    env_http_headers: { 'x-happier-machine-local-capability': 'HAPPIER_CODEX_PROVIDER_API_KEY' },
  });
  expect(h.requester.readAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({ status: 'ready', revision: 2 });
  expect(getActiveAccountSettingsSnapshot()).toEqual(ambient);
  expect(brokerOpens).toBe(1);
  h.f.retire();
  await expect(open()).rejects.toThrow('requester_session_not_current');
  expect(brokerOpens).toBe(1);
  } finally {
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ happyHomeDir: configuration.happyHomeDir,
      publicReleaseRing: configuration.publicReleaseRing, path, capabilityDigest: published.capabilityDigest });
  }
});
