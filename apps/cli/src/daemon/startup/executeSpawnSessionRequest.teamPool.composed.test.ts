import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, FeaturesResponseSchema,
  ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { TEAM_CREDENTIAL_ACTION_PATHS_V1 } from '@happier-dev/protocol/teams/credentials/actionsV1';
import { TeamCredentialResourceReadInputV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createSharedGatewayRegistryTestkit } from '@/plugins/runtime/sharedGatewayRegistry.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import { projectAgentProviderBrokerApplications } from '@/providers/broker/applicationProjection';
import { openSessionTeamCredentialProviderBinding } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH, PROVIDER_BROKER_ENDPOINT_PATH_HEADER } from '@/providers/broker/providerBrokerPrivateProtocol';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { configuration, reloadConfiguration } from '@/configuration';
import { ApiClient } from '@/api/api';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import { createMachineSessionDirectTargetTransport } from '@/rpc/handlers/sessionServerStartLifecycleAdapter';
import { readSessionTeamCredentialResourceCatalog, readSessionTeamCredentialProviderModels } from '@/session/services/sessionTeamCredentialLaunch';
import { createNativeSessionClientTestPort } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { SessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';

// Only process creation is replaced. Production daemon preparation creates
// the bootstrap/attach files; the admitted external Agent runs in this worker.
const os = vi.hoisted(() => ({ runner: null as null | ((args: readonly string[], environment: NodeJS.ProcessEnv) => void), pid: 0 }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (os.runner && Array.isArray(args[1]) && args[1].some(value => value === '--existing-session')) {
      const child = new actual.ChildProcess();
      Object.defineProperty(child, 'pid', { value: os.pid });
      const run = os.runner;
      os.runner = null;
      const environment = args[2]?.env ?? {};
      setImmediate(() => run(args[1] as string[], environment));
      return child;
    }
    return actual.spawn(...args);
  } };
});

// The source resolver handles cross-package aliases relative to their owner.
const server = '../../../../server/sources/';
const { createLightSqliteHarness }: typeof import('../../../../server/sources/testkit/lightSqliteHarness') = await import(server + 'testkit/lightSqliteHarness');
const { createAuthenticatedTestApp }: typeof import('../../../../server/sources/app/api/testkit/sqliteFastify') = await import(server + 'app/api/testkit/sqliteFastify');
const { registerSessionCreateOrLoadRoute }: typeof import('../../../../server/sources/app/api/routes/session/registerSessionCreateOrLoadRoute') = await import(server + 'app/api/routes/session/registerSessionCreateOrLoadRoute');
const { registerSessionListingRoutes }: typeof import('../../../../server/sources/app/api/routes/session/registerSessionListingRoutes') = await import(server + 'app/api/routes/session/registerSessionListingRoutes');
const { db }: typeof import('../../../../server/sources/storage/db') = await import(server + 'storage/db');
const { inTx }: typeof import('../../../../server/sources/storage/inTx') = await import(server + 'storage/inTx');
const { readTeamCredentialCatalogInTx }: typeof import('../../../../server/sources/app/teams/credentials/resourceRead') = await import(server + 'app/teams/credentials/resourceRead');
const { projectTeamCredentialProviderModels }: typeof import('../../../../server/sources/app/teams/credentials/providerModelProjection') = await import(server + 'app/teams/credentials/providerModelProjection');
const { openTeamCredentialProviderBroker }: typeof import('../../../../server/sources/app/teams/credentials/providerBrokerAdmission') = await import(server + 'app/teams/credentials/providerBrokerAdmission');
const { createQualifiedConnectedAccountServiceDigest, createQualifiedConnectedAccountGroupDigest }: typeof import('../../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/identity') = await import(server + 'app/api/routes/connect/qualifiedConnectedAccounts/identity');
const { listTeamsForActorInTx }: typeof import('../../../../server/sources/app/teams/queries') = await import(server + 'app/teams/queries');

afterEach(() => { os.runner = null; resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); });

describe('Team Pool Session launch through Action/CLI and an external Agent', () => {
  it.each(['cli', 'rpc'] as const)('runs gpt-5.5 from the recipient confirmation through %s ingress and protected attach', async surface => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-team-pool-journey-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-team-pool-journey-db-', env: {
      HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
    } });
    env.patch({ HAPPIER_HOME_DIR: join(directory, 'worker') }); reloadConfiguration();
    const service = { pluginId: 'acme.shared-registry', localId: 'accounts' };
    const worker = await createManagedRunLaunchFixture({ directory: join(directory, 'agent'), happyHomeDir: configuration.happyHomeDir,
      controller: pluginReloadController, physicalGateway: true,
      connectedAccounts: [{ purpose: 'primary', service, required: false, credentialKinds: ['oauth'], materializationKinds: ['httpHeaders'] }] });
    const source = createSharedGatewayRegistryTestkit({ directory: join(directory, 'source'),
      catalog: { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] },
      compatibilityOverrides: [{ agentTargetKey: worker.agentTargetKey, protocol: 'openai-responses', status: 'experimental', reason: 'Controlled source contract' }],
      resolveAccountTarget: async (_target, signal) => { signal.throwIfAborted(); return {
        account: { service, accountId: 'synthetic-pool-member' }, displayName: 'Pool', group: { groupId: 'pool', generation: 1 } };
      } });
    const requests: unknown[] = [];
    const carrier = createServer(async (request, response) => {
      if (request.url === PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH) {
        response.writeHead(204, { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1' }).end(); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ output_text: 'TEAM_POOL_NATIVE_SENTINEL' }));
    });
    carrier.listen(0, '127.0.0.1'); await once(carrier, 'listening');
    const carrierAddress = carrier.address();
    if (!carrierAddress || typeof carrierAddress === 'string') throw new Error('Missing controlled carrier');
    const app = createAuthenticatedTestApp();
    const authentication = { env: process.env, authority: 'present_user', authenticationEvidence: [] } as const;
    try {
      await source.install(source.pluginId, '1.0.0', true);
      const sourceLease = await source.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: () => source.createRegistry(new Set()) });
      expect(sourceLease.registry.contributes.agentDefinitionsById.has(worker.agentId)).toBe(false);
      const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
      const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
      const team = await db.team.create({ data: { name: 'Pool journey' } });
      const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
      await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
      const broker = await db.machine.create({ data: { id: 'broker', accountId: custodian.id, metadata: '{}', kind: 'persistent', active: true,
        operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] }, irohMachineEndpoint: { protocolVersions: [1], endpointId: 'b'.repeat(64) } }, operationProtocolCapabilitiesRevision: 1 } });
      await db.machine.create({ data: { id: worker.machineId, accountId: recipient.id, metadata: '{}', kind: 'persistent', active: true,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64) } }, operationProtocolCapabilitiesRevision: 1 } });
      const pool = await db.connectedServiceAuthGroup.create({ data: { accountId: custodian.id, servicePluginId: service.pluginId,
        serviceLocalId: service.localId, qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
        qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId: 'pool' }), groupId: 'pool', policyJson: '{}' } });
      const target = { kind: 'group' as const, service, groupId: 'pool' };
      const binding = { v: 1 as const, kind: 'connected_pool' as const, target, poolIncarnation: pool.id };
      const resource = await db.teamCredentialResource.create({ data: { teamId: team.id, custodianAccountId: custodian.id,
        displayName: 'Shared Pool', enabled: true, disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed',
        sourceBindingJson: JSON.stringify(binding), requestPolicyJson: null, brokerMachineId: broker.id,
        memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: 'brokered' } } } });
      const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: recipient.id })).toString('base64url')}.fixture`, encryption: null } as const;
      const empty = splitProviderSettingsV1(ProviderSettingsV1Schema.parse(DEFAULT_PROVIDER_SETTINGS_V1)).catalog;
      const recipientSnapshot = { ...worker.snapshot, scopeKey: resolveAccountSettingsScopeKey(credentials),
        settings: AccountSettingsSchema.parse({}), providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog: empty } };
      setActiveAccountSettingsSnapshot(recipientSnapshot);
      const unavailable = async (): Promise<never> => { throw new Error('Unexpected private source mutation'); };
      const sourceRuntime = createRuntimeProviderModelManagementServices({ machineId: broker.id, happyHomeDir: source.happyHomeDir,
        featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => recipientSnapshot,
        acquireRuntimeLease: async () => ({ ...sourceLease, release: async () => {} }), modelSettingsMutation: unavailable,
        resolveManagedPurposeBindingIntentSelection: source.purposeBindingOwner.resolveBindingIntentSelection });
      const project = (application: Parameters<typeof projectTeamCredentialProviderModels>[0]['application']) => sourceRuntime.projectModels({
        machineId: broker.id, agentTargetKey: worker.agentTargetKey, connectedAccountTarget: target,
        sourceCatalog: true, application, refreshPolicy: 'current_only' });
      app.addHook('onRequest', async request => { request.headers['x-test-user-id'] = recipient.id; });
      registerSessionCreateOrLoadRoute(app); registerSessionListingRoutes(app);
      app.get('/v1/features', async () => FeaturesResponseSchema.parse({ features: { providers: { enabled: true } },
        capabilities: { encryption: { storagePolicy: 'optional' } } }));
      app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
      app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
      app.post('/v2/sessions/lookup-by-tags', async () => ({ sessions: [] }));
      app.post('/v1/teams/list', async () => {
        const result = await inTx(tx => listTeamsForActorInTx(tx, { actorAccountId: recipient.id,
          scope: 'member', archived: 'active', authentication }));
        if (!result.ok) throw new Error(result.error);
        return result.page;
      });
      app.post(TEAM_CREDENTIAL_ACTION_PATHS_V1['teams.credentials.entitled.list'], async request => {
        const input = TeamCredentialResourceReadInputV1Schema.parse(request.body);
        const read = await inTx(tx => readTeamCredentialCatalogInTx(tx, { ...input, actorAccountId: recipient.id, authentication }));
        if (!read.ok) throw new Error(read.error);
        if (!input.application) return read.page;
        const projected = projectTeamCredentialProviderModels({ response: await project(input.application), resourceId: resource.id,
          teamId: team.id, resourceRevision: resource.revision, agentTargetKey: worker.agentTargetKey,
          application: input.application, allowedModelIds: null, source: binding, deliveryMode: 'brokered' });
        if (projected.status !== 'success') throw new Error(projected.reason);
        return { ...read.page, resources: read.page.resources.map(row => ({ ...row, providerModels: projected.models })) };
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing Home address');
      const origin = `http://127.0.0.1:${address.port}`;
      await runWithServerHttpBaseUrl(origin, async () => {
        const homeDomainAction = createAccountServerActionDeps({ token: credentials.token, credentials }).homeDomainAction!;
        const applications = projectAgentProviderBrokerApplications({ registry: worker.lease.registry.contributes,
          agentTargetKey: worker.agentTargetKey, acceptedProtocols: readLeasedAgentProviderRequirements({ lease: worker.lease, agentId: worker.agentId })!.acceptsProtocols });
        const resources = await readSessionTeamCredentialResourceCatalog({ homeDomainAction, applications, teamIds: [team.id] });
        const offered = resources.flatMap(row => row.providerModels).find(row => row.descriptor.id === 'gpt-5.5');
        if (!offered) throw new Error('Home did not offer the source gpt-5.5 row');
        const recipientRuntime = createRuntimeProviderModelManagementServices({ machineId: worker.machineId, happyHomeDir: worker.happyHomeDir,
          featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => recipientSnapshot,
          acquireRuntimeLease: async () => ({ ...worker.lease, release: async () => {} }), modelSettingsMutation: unavailable });
        const local = await recipientRuntime.projectModels({ machineId: worker.machineId, agentTargetKey: worker.agentTargetKey,
          teamCredentialModel: offered, refreshPolicy: 'current_only' });
        expect(local).toMatchObject({ status: 'success', groups: [{ rows: [{ compatibility: { confirmed: false } }] }] });
        if (local.status !== 'success') throw new Error('Worker compatibility unavailable');
        const compatibility = local.groups[0]!.rows[0]!.compatibility;
        if (compatibility.result.status !== 'experimental') throw new Error('Expected recipient consent');
        const confirm = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 2,
          readDefinitions: async () => [], readCatalog: async () => recipientSnapshot.providerConnectionsCatalog,
          writeCatalog: async write => { recipientSnapshot.providerConnectionsCatalog = { status: 'ready', revision: write.expectedRevision + 1, catalog: write.catalog }; return { status: 'updated' }; } });
        expect(await confirm(parseProviderActionRequestV1('providers.models.experimental.confirm', { action: 'confirmExperimental',
          ...offered.confirmationSource, expectedConnectionRevision: 0, agentTargetKey: worker.agentTargetKey,
          modelId: compatibility.result.confirmationScope.kind === 'model' ? 'gpt-5.5' : null,
          compatibilityFingerprint: compatibility.compatibilityFingerprint }), {})).toMatchObject({ ok: true });
        setActiveAccountSettingsSnapshot(recipientSnapshot);
        const api = await ApiClient.create(credentials);
        const tracked = new Map<number, import('../types').TrackedSession>();
        const resolvers = new Map<number, (result: import('@/session/shared/spawnSessionContract').SpawnSessionResult) => void>();
        const timeouts = new Map<number, NodeJS.Timeout>();
        let runner: Promise<void> | undefined;
        let sessionId = '';
        os.pid = process.pid + 1_000_000;
        const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
        const lifetime = new AbortController();
        os.runner = (args, environment) => { runner = (async () => {
          const index = args.indexOf('--existing-session'); sessionId = args[index + 1]!;
          const attachPath = environment.HAPPIER_SESSION_ATTACH_FILE;
          if (!attachPath) throw new Error('Real daemon omitted protected attach');
          const plan = await new SessionHostBridge().createSessionRuntime(worker.agentId, {
            credentials, directory, happyHomeDir: worker.happyHomeDir, existingSessionId: sessionId, sessionAttachFilePath: attachPath,
            backendTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
            modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: worker.agentTargetKey, providerConnectionId: null, modelId: 'gpt-5.5' } },
          }, { pluginRuntimeRegistryLease: worker.lease, prepareTeamCredentialProviderBinding: async input => {
            const opened = await openSessionTeamCredentialProviderBinding({ ...input, machineId: worker.machineId,
              agentId: worker.agentId, binding: { v: 1, slot: { kind: 'provider_model' }, resourceId: input.resourceId,
                expectedResourceRevision: input.expectedResourceRevision, deliveryMode: 'brokered', teamId: team.id },
              lease: worker.lease, materializationBaseDir: join(directory, 'materialized'),
              readCatalog: signal => readSessionTeamCredentialProviderModels({ homeDomainAction, lease: worker.lease,
                agentId: worker.agentId, agentTargetKey: worker.agentTargetKey, teamId: team.id, resourceId: resource.id, signal }),
              openBroker: request => openTeamCredentialProviderBroker({ actorAccountId: recipient.id, authentication,
                request, readCurrentPresence: async () => ({ initiatorPresence: { state: 'known', machineIds: new Set([worker.machineId]) },
                  brokerPresence: { state: 'known', machineIds: new Set([broker.id]) } }), nowMs: Date.now(), grantId: crypto.randomUUID(),
                signingKey: { keyId: 'journey', secretKey: signingKey.secretKey }, readProviderProjection: request => project(request.application),
                readPoolSourceEligibility: async () => ({ eligibleMachineIds: new Set([broker.id]), reasons: new Map() }) }),
              openTunnel: async () => ({ localPort: carrierAddress.port, localCapability: 'synthetic-carrier-capability', observedPath: 'relay',
                retire: async () => {}, close: async () => {} }),
            });
            if (!opened) throw new Error('Accepted Team binding was not opened');
            return opened;
          } });
          const session = createNativeSessionClientTestPort(sessionId);
          const presentation = createCurrentSessionPresentationHost({ session, signal: lifetime.signal });
          const runtime = await plan.config.createSessionRuntime?.({ directory, metadata: {}, machineId: worker.machineId,
            session, currentSessionPresentation: presentation.bindCurrentSession, transcriptSession: {}, messageBuffer: {},
            mcpServers: {}, permissionHandler: {}, getPermissionMode: () => 'safe-yolo', memoryRecallGuidanceEnabled: false } as never);
          if (!runtime) throw new Error('External runtime unavailable');
          const operations = (runtime as Readonly<{ operations: Readonly<{
            sendTurnPrompt(text: string, input: Readonly<{ turnId: string; localId: string; userMessageSeq: number }>): Promise<void>;
            resetOrDisposeRuntime(): Promise<void>;
          }> }>).operations;
          await operations.sendTurnPrompt('TEAM_POOL_NATIVE_SENTINEL', { turnId: 'team-turn', localId: 'team-input', userMessageSeq: 1 });
          await operations.resetOrDisposeRuntime();
          await expect(readFile(attachPath)).rejects.toMatchObject({ code: 'ENOENT' });
          const timer = timeouts.get(os.pid); if (timer) clearTimeout(timer);
          resolvers.get(os.pid)?.({ type: 'success', sessionId });
        })(); void runner.catch(error => {
          const timer = timeouts.get(os.pid); if (timer) clearTimeout(timer);
          resolvers.get(os.pid)?.({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: String(error) });
        }); };
        const handler = createSpawnNewSessionLifecycleActionHandler({ serverId: configuration.activeServerId,
          spawnSession: options => executeSpawnSessionRequest({ options, credentials, api,
            connectedServicesMaterializationBaseDir: join(directory, 'connected-services'), connectedServiceRefreshCoordinator: null,
            connectedServiceQuotasCoordinator: null, connectedServiceRuntimeRegistry: { registerTarget() {} },
            pidToTrackedSession: tracked, pidToAwaiter: new Map(), pidToSpawnResultResolver: resolvers, pidToSpawnWebhookTimeout: timeouts,
            spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
            resolveCanonicalTrackedSessionId: pid => tracked.get(pid)?.happySessionId ?? '', onChildExited() {},
            processEnv: { ...process.env, HAPPIER_HOME_DIR: worker.happyHomeDir }, resolveProvidersFeatureEnabled: () => true }) });
        try {
          const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
            sessionSpawnDirectTargetTransport: createMachineSessionDirectTargetTransport({ machineId: worker.machineId, spawnLifecycleHandler: handler }) });
          const result = await createActionExecutor(deps).execute('session.spawn_new', {
            creationKey: `team-pool-${surface}`, executionTarget: { serverId: configuration.activeServerId, machineId: worker.machineId },
            directory: { kind: 'path', path: directory }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.managed-run', localId: 'agent' } },
            permissionMode: 'default', modelSelection: { v: 1, updatedAt: 1,
              ref: { agentTargetKey: worker.agentTargetKey, providerConnectionId: null, modelId: 'gpt-5.5' } },
            connectedServices: { v: 2, bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: {
              source: 'team_resource', resourceId: resource.id, deliveryMode: 'brokered' } } },
          }, { surface, authority: 'present_user', actionCaller: { kind: 'host' } });
          await runner;
          expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'success' } });
          expect(requests).toEqual([{ model: 'gpt-5.5', input: 'TEAM_POOL_NATIVE_SENTINEL' }]);
          expect(await db.sessionTeamCredentialBinding.findMany({ where: { sessionId } })).toEqual(expect.arrayContaining([
            expect.objectContaining({ slotKind: 'provider_model:brokered', resourceId: resource.id }),
          ]));
        } finally { lifetime.abort(); for (const timer of timeouts.values()) clearTimeout(timer); }
      });
      await sourceLease.release();
    } finally {
      await app.close(); await new Promise<void>(resolve => carrier.close(() => resolve()));
      await source.controller.shutdown(); source.disposeCredentialBoundary(); await worker.cleanup();
      await harness.close(); env.restore(); reloadConfiguration(); await rm(directory, { recursive: true, force: true });
    }
  });
});
