import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import axios from 'axios';
import { AccountSettingsSchema, FeaturesResponseSchema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';

// Only the daemon's OS listener is substituted. The installed requester opener,
// credentialed Action factory, provider projector and external plugin stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it('projects the admitted requester catalog through the real daemon factory on a foreign worker and retires without ambient disclosure', async () => {
  const controller = createPluginReloadController();
  const fixture = await createManagedRunLaunchFixture({ controller, physicalGateway: true });
  const homeId = 'srv_requester_provider';
  const endpoint = 'https://requester-provider.test';
  const requesterToken = `e30.${Buffer.from(JSON.stringify({ sub: 'requester-a', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const custodianToken = `e30.${Buffer.from(JSON.stringify({ sub: 'worker-b' })).toString('base64url')}.signature`;
  let current = true;
  let privateCustodianReads = 0;
  let requesterSourceReads = 0;
  const ambient = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken(custodianToken),
    providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(ProviderSettingsV1Schema.parse({
      ...fixture.providerSettings, connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
        displayName: 'Private B source', displayNameMode: 'custom' })),
    })).catalog } };
  setActiveAccountSettingsSnapshot(ambient);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => {
    if (new URL(String(url)).pathname === '/v1/account/profile') return Response.json({ id: 'requester-a' });
    throw new Error('Unexpected requester fetch');
  }));
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    if (options?.headers?.Authorization === `Bearer ${custodianToken}`) privateCustodianReads++;
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'requester-a' } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, settingsVersion: 1, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: AccountSettingsSchema.parse({}) } } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: { status: 'present', revision: 1,
      content: { t: 'plain', v: fixture.snapshot.providerConnectionsCatalog?.status === 'ready' ? fixture.snapshot.providerConnectionsCatalog.catalog : {} } } };
    if (path === '/v4/connect/qualified/accounts') {
      expect(options?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
      requesterSourceReads++;
      const service = { pluginId: fixture.gateway!.pluginId, localId: 'accounts' };
      return { status: 200, data: QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
        ref: { service, accountId: 'upstream-account' }, status: 'connected', authenticationModeId: 'manual',
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationReady: true, configurationRevision: null, scopes: [],
      }] }) };
    }
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    throw new Error(`Unexpected requester read: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async url => {
    if (String(url).endsWith('/execution-authorization/verify')) return { status: current ? 200 : 401, data: { ok: current } };
    throw new Error(`Unexpected requester write: ${new URL(String(url)).pathname}`);
  });
  const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
    happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
    getAccountSettingsSnapshot: () => { privateCustodianReads++; return ambient; },
    acquireRuntimeLease: async () => {
      const lease = controller.tryAcquireRuntimeRegistry();
      if (!lease) throw new Error('Expected external plugin registry');
      return lease;
    }, modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected model mutation'); },
  });
  const host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: fixture.happyHomeDir,
    activeServerDir: join(fixture.happyHomeDir, 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
    machineId: fixture.machineId, custodianAccountId: 'worker-b', credentials: { token: custodianToken, encryption: null },
    connectedServicesMaterializationBaseDir: join(fixture.happyHomeDir, 'connected-services'), registry: new ConnectedServiceRuntimeRegistry(),
    trackedSessions: new Map(), getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    startup: { pluginRuntimeController: controller, projectProviderModelsForAccount: services.projectModelsForAccount,
      resolveServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: { providers: { enabled: true } }, capabilities: {} }) }),
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: fixture.machineId, serverIdentityId: homeId }) } });
  const channel = await createRequesterCurrentnessSocketHarness();
  try {
    privateCustodianReads = 0;
    const installation = host.installation;
    const prepare = host.runtime.externalActionIngressOwner?.prepareRequesterAccountContext;
    if (!installation || !prepare) throw new Error('Expected real daemon Account ingress');
    const input = { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, mode: 'management',
      sourceConnectionId: 'run-gateway', refreshPolicy: 'current_only' } as const;
    const target = { kind: 'machine', machineId: fixture.machineId } as const;
    for (const actionId of ['providers.models.projection', 'providers.models.refresh'] as const) {
      const actionInput = actionId === 'providers.models.refresh' ? { ...input, forceRefresh: true as const } : input;
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: actionId, target, input: actionInput });
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-provider-root', binding: {
        accountId: 'requester-a', custodianAccountId: 'worker-b', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
        serverIdentityId: homeId, machineId: fixture.machineId, installationId: installation.installationId,
        actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose: { kind: 'external_action' },
        installationPublicKey: decodeBase64(installation.publicKey, 'base64url'), credentials: { token: requesterToken },
        randomBytes: length => new Uint8Array(randomBytes(length)) });
      const admitted = await prepare({ authorization });
      expect(admitted).not.toBeNull();
      if (!admitted) throw new Error('Expected admitted requester Account');
      try {
        const execute = () => admitted.executor.execute(actionId, actionInput, { surface: 'ui', authority: 'present_user',
          serverId: homeId, defaultSessionMachineId: fixture.machineId, actionRequestId: envelope.requestId,
          externalActionExecutionAuthorization: admitted.authorization, externalActionTarget: target, signal: new AbortController().signal });
        const result = await execute();
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'success',
          groups: [{ connectionName: 'Gateway', rows: [{ descriptor: { id: 'example' } }] }] } });
        if (!result.ok) throw new Error('Expected successful Provider Action');
        DaemonProviderModelProjectionResponseV1Schema.parse(result.result);
        expect(privateCustodianReads).toBe(0);
        expect(requesterSourceReads).toBeGreaterThan(0);
        const sourceReadsBeforeRetirement = requesterSourceReads;
        current = false;
        await expect(execute()).resolves.toMatchObject({ ok: false });
        expect(privateCustodianReads).toBe(0);
        expect(requesterSourceReads).toBe(sourceReadsBeforeRetirement);
      } finally { current = true; await admitted.dispose(); }
    }
  } finally {
    try { await host.dispose(); } finally { try { await channel.close(); } finally { await fixture.cleanup(); } }
  }
});
