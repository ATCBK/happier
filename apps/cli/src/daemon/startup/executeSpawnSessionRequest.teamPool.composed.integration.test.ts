import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';
import { DaemonProviderModelProjectionRequestV1Schema, DaemonProviderTeamCredentialBrokerEligibilityRequestV1Schema } from '@happier-dev/protocol/rpc/providers';
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
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createSpawnHappyCliEnvScope, withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';
import { logger } from '@/ui/logger';
import { PROVIDER_BROKER_OPEN_HTTP_PATH_V1, ProviderBrokerOpenResponseV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';

// Only process creation is replaced. Production daemon preparation creates
// the bootstrap/attach files; the admitted external Agent runs in this worker.
const os = { runner: null as null | ((args: readonly string[], environment: NodeJS.ProcessEnv) => void), pid: 0,
  child: null as ChildProcess | null,
  observed: [] as Array<{ executable: string; existingSessionFlag: boolean; argc: number }>,
};
function installProcessBoundary(): void {
  // Node's genuine CJS adapter is mutable; synchronize its named ESM bindings
  // so source modules loaded outside Vitest's mock graph use the same boundary.
  const require = createRequire(import.meta.url);
  const actual: typeof import('node:child_process') = require('node:child_process');
  const spawn = actual.spawn;
  vi.spyOn(actual, 'spawn').mockImplementation((...args: Parameters<typeof actual.spawn>) => {
    if (os.runner) os.observed.push({ executable: String(args[0]).split(/[\\/]/u).at(-1) ?? '',
      existingSessionFlag: Array.isArray(args[1]) && args[1].includes('--existing-session'),
      argc: Array.isArray(args[1]) ? args[1].length : 0 });
    if (os.runner && Array.isArray(args[1]) && args[1].some(value => value === '--existing-session')) {
      // Startup markers validate live OS identity. Keep an owned process at
      // this boundary while the actual Agent runtime executes in this worker.
      const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'],
      });
      if (!child.pid) throw new Error('Controlled runner process did not start');
      os.child = child;
      os.pid = child.pid;
      const run = os.runner;
      os.runner = null;
      const environment = args[2]?.env ?? {};
      setImmediate(() => run(args[1] as string[], environment));
      return child;
    }
    return spawn(...args);
  });
  syncBuiltinESMExports();
}

// The source integration resolver handles cross-package aliases relative to their owner.
const server = '../../../../server/sources/';
const { createLightSqliteHarness }: typeof import('../../../../server/sources/testkit/lightSqliteHarness') = await import(server + 'testkit/lightSqliteHarness');
const { createAuthenticatedTestApp }: typeof import('../../../../server/sources/app/api/testkit/sqliteFastify') = await import(server + 'app/api/testkit/sqliteFastify');
const { registerSessionCreateOrLoadRoute }: typeof import('../../../../server/sources/app/api/routes/session/registerSessionCreateOrLoadRoute') = await import(server + 'app/api/routes/session/registerSessionCreateOrLoadRoute');
const { registerSessionListingRoutes }: typeof import('../../../../server/sources/app/api/routes/session/registerSessionListingRoutes') = await import(server + 'app/api/routes/session/registerSessionListingRoutes');
const { accessKeysRoutes }: typeof import('../../../../server/sources/app/api/routes/accessKeys/accessKeysRoutes') = await import(server + 'app/api/routes/accessKeys/accessKeysRoutes');
const { db }: typeof import('../../../../server/sources/storage/db') = await import(server + 'storage/db');
const { registerTeamRoutes }: typeof import('../../../../server/sources/app/teams/registerTeamRoutes') = await import(server + 'app/teams/registerTeamRoutes');
const { resolveServerFeaturesForGating }: typeof import('../../../../server/sources/app/features/catalog/serverFeatureGate') = await import(server + 'app/features/catalog/serverFeatureGate');
const { createSessionPublisherPresence }: typeof import('../../../../server/sources/app/presence/sessionPublisherPresence') = await import(server + 'app/presence/sessionPublisherPresence');
const { openTeamCredentialProviderBroker }: typeof import('../../../../server/sources/app/teams/credentials/providerBrokerAdmission') = await import(server + 'app/teams/credentials/providerBrokerAdmission');
const { writeSessionTeamCredentialBindingsInTx }: typeof import('../../../../server/sources/app/teams/credentials/sessionBinding') = await import(server + 'app/teams/credentials/sessionBinding');
const { inTx }: typeof import('../../../../server/sources/storage/inTx') = await import(server + 'storage/inTx');
const { createQualifiedConnectedAccountServiceDigest, createQualifiedConnectedAccountGroupDigest,
  createQualifiedConnectedAccountIdentityDigest, createServiceAccountTokenIdentityFields }: typeof import('../../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/identity') = await import(server + 'app/api/routes/connect/qualifiedConnectedAccounts/identity');

async function closeControlledRunner(): Promise<void> {
  const child = os.child; os.child = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    await once(child, 'exit');
  }
}

afterEach(async () => {
  os.runner = null;
  await closeControlledRunner();
  resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe('Team Pool Session launch through Action/CLI and an external Agent', () => {
  let harness: Awaited<ReturnType<typeof createLightSqliteHarness>>;
  // Reuse the broker-admission suite's SQLite setup lifecycle and budget;
  // migration/setup must not consume each ordinary Session launch's budget.
  beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-team-pool-journey-db-', env: {
      HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
      HAPPIER_FEATURE_PROVIDERS__ENABLED: '1',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
    } });
  }, 180_000);
  afterAll(async () => { await harness?.close(); });

  const runJourney = async (brokerOnly: boolean, onTestFailed: TestContext['onTestFailed']) => withTempHappyCliEntrypoint(async entrypoint => {
    let phase = 'setup';
    let runnerFailure: string | null = null;
    const answersObserved: string[] = [];
    const completedIngresses: string[] = [];
    let readLaunchPhases: () => unknown = () => [];
    let readLaunchMessages: () => readonly string[] = () => [];
    onTestFailed(() => { console.error('Team Pool deciding failure', { phase, runnerFailure, answersObserved, completedIngresses,
      launchPhases: readLaunchPhases(), launchMessages: readLaunchMessages(), os: os.observed }); });
    const surface = brokerOnly ? 'broker-catalog' : 'shared';
    const launchEnv = createSpawnHappyCliEnvScope();
    launchEnv.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
      HAPPIER_MANAGED_NODE_BIN: process.execPath, HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
      // The executor may itself be launched by a runtime-backed Stack. That
      // immutable-closure identity is not this disposable OS fixture's runtime.
      HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined,
      HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: undefined,
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: undefined,
      HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: undefined,
      HAPPIER_WINDOWS_SESSION_RUNNER_BINARY: undefined,
      HAPPIER_STACK_REPO_DIR: undefined,
      HAPPIER_STACK_CLI_ROOT_DIR: undefined,
      HAPPIER_STACK_STACK: undefined,
    });
    const directory = await mkdtemp(join(tmpdir(), 'happier-team-pool-journey-'));
    // The native CLI is an OS boundary: install the same version-only shim
    // used by the managed-gateway composition; no native credential is supplied.
    const nativeCli = writeExecutableShimSync({ dir: directory, fileName: process.platform === 'win32' ? 'managed-run-agent.cmd' : 'managed-run-agent',
      contents: process.platform === 'win32' ? '@echo off\r\necho 1.0.0\r\n' : '#!/bin/sh\necho 1.0.0\n' });
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH',
      'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID', 'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY',
      'HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY']);
    env.patch({ HAPPIER_HOME_DIR: join(directory, 'worker'), PATH: `${directory}${delimiter}${process.env.PATH ?? ''}` }); reloadConfiguration();
    const routeSigningSeed = new Uint8Array(32).fill(43);
    env.patch({ HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'broker-catalog',
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(routeSigningSeed).toString('base64url'),
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: Buffer.from(tweetnacl.sign.keyPair.fromSeed(routeSigningSeed).publicKey).toString('base64url') });
    // Use the pinned broker's real upstream family/model registry. The
    // independent external Agent is installed only on the worker.
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const worker = await createManagedRunLaunchFixture({ directory: join(directory, 'agent'), happyHomeDir: configuration.happyHomeDir,
      controller: pluginReloadController, physicalGateway: true, signedOutAgentCli: true, readUpstreamAnswer: true,
      includeBundledDeclarations: true,
      connectedAccounts: [{ purpose: 'primary', service, required: false, credentialKinds: ['oauth'], materializationKinds: ['httpHeaders'] }] });
    const source = createSharedGatewayRegistryTestkit({ directory: join(directory, 'source'),
      includeBundledDeclarations: true,
      resolveAccountTarget: async (_target, signal) => { signal.throwIfAborted(); return {
        account: { service, accountId: 'synthetic-pool-member' }, displayName: 'Pool', group: { groupId: 'pool', generation: 1 } };
      } });
    const requests: unknown[] = [];
    const sourceRpcFailures: unknown[] = [];
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
    const authentication = { env: process.env, authority: 'present_user', authenticationEvidence: [], tokenEpoch: 0 } as const;
    let releaseSource: (() => Promise<void>) | undefined;
    try {
      const agentEntry = await worker.lease.registry.acquireAgentCatalogEntry?.(worker.agentId);
      const auth = await agentEntry?.getCliAuthSpec?.();
      expect(await auth?.detectAuthStatus?.({ resolvedPath: nativeCli, processEnv: { ...process.env, RUN_NATIVE_API_KEY: '' } }))
        .toMatchObject({ state: 'logged_out' });
      await source.install(source.pluginId, '1.0.0', true);
      const sourceLease = await source.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: () => source.createRegistry(new Set()) });
      releaseSource = async () => { await sourceLease.release(); };
      expect(sourceLease.registry.contributes.agentDefinitionsById.has(worker.agentId)).toBe(false);
      const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
      const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
      const team = await db.team.create({ data: { name: 'Pool journey' } });
      const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
      await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
      const broker = await db.machine.create({ data: { id: `broker-${surface}`, accountId: custodian.id, metadata: '{}', kind: 'persistent', active: true,
        operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] }, irohMachineEndpoint: { protocolVersions: [1], endpointId: 'b'.repeat(64) } }, operationProtocolCapabilitiesRevision: 1 } });
      await db.machine.create({ data: { id: worker.machineId, accountId: recipient.id, metadata: '{}', kind: 'persistent', active: true,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64) } }, operationProtocolCapabilitiesRevision: 1 } });
      const pool = await db.connectedServiceAuthGroup.create({ data: { accountId: custodian.id, servicePluginId: service.pluginId,
        serviceLocalId: service.localId, qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
        qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId: 'pool' }), groupId: 'pool', policyJson: '{}' } });
      const sourceAccount = { service, accountId: 'synthetic-pool-member' };
      const credential = await db.serviceAccountToken.create({ data: { accountId: custodian.id,
        ...createServiceAccountTokenIdentityFields({ ref: sourceAccount, authenticationModeId: 'manual' }),
        token: Buffer.from('synthetic-source-credential'), metadata: { v: 4, storage: 'stored_envelope_v1',
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', values: { scopes: [] } } } });
      await db.connectedServiceAuthGroupMember.create({ data: { groupDbId: pool.id, accountId: custodian.id,
        credentialId: credential.id, qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
        qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId: 'pool' }),
        qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(sourceAccount), priority: 0, enabled: true } });
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
      const project = (application: import('@happier-dev/protocol').ProviderBrokerApplicationBindingV1) => sourceRuntime.projectModels({
        machineId: broker.id, agentTargetKey: worker.agentTargetKey, connectedAccountTarget: target,
        sourceCatalog: true, application, refreshPolicy: 'current_only' });
      app.addHook('onRequest', async request => {
        request.headers['x-test-user-id'] = recipient.id;
        request.authTokenEpoch = recipient.tokenEpoch;
      });
      app.decorate('machineDaemonPresence', { in: () => ({ fetchSockets: async () => [
        { data: { clientType: 'machine-scoped', userId: recipient.id, machineId: worker.machineId } },
        { data: { clientType: 'machine-scoped', userId: custodian.id, machineId: broker.id } },
      ] }) });
      // RPC is the cross-Machine boundary; retain the real Home route and
      // source runtime beneath it, including their strict request consumers.
      app.decorate('forwardRpcForUser', async (request: Readonly<{ method: string; params: unknown }>) => {
        try {
        if (request.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION}`)) return {
          ok: true, result: await sourceRuntime.projectModels(DaemonProviderModelProjectionRequestV1Schema.parse(request.params)) };
        if (request.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY}`)) return {
          ok: true, result: await sourceRuntime.resolveTeamCredentialBrokerEligibility(DaemonProviderTeamCredentialBrokerEligibilityRequestV1Schema.parse(request.params)) };
        throw new Error(`Unexpected source RPC ${request.method}`);
        } catch (error) { sourceRpcFailures.push(error); throw error; }
      });
      registerSessionCreateOrLoadRoute(app); registerSessionListingRoutes(app); accessKeysRoutes(app);
      registerTeamRoutes(app);
      app.get('/v1/features', async () => resolveServerFeaturesForGating(process.env));
      app.get('/v1/account/profile', async () => AccountProfileResponseSchema.parse({ id: recipient.id }));
      app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
      app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
      app.post('/v2/sessions/lookup-by-tags', async () => ({ sessions: [] }));
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing Home address');
      const origin = `http://127.0.0.1:${address.port}`;
      await runWithServerHttpBaseUrl(origin, async () => {
        const homeDomainAction = createAccountServerActionDeps({ token: credentials.token, credentials }).homeDomainAction!;
        const applications = projectAgentProviderBrokerApplications({ registry: worker.lease.registry.contributes,
          agentTargetKey: worker.agentTargetKey, acceptedProtocols: readLeasedAgentProviderRequirements({ lease: worker.lease, agentId: worker.agentId })!.acceptsProtocols });
        const resources = await readSessionTeamCredentialResourceCatalog({ homeDomainAction, applications, teamIds: [team.id] });
        expect(applications.length).toBeGreaterThan(0);
        expect(sourceRpcFailures).toEqual([]);
        const offered = resources.flatMap(row => row.providerModels).find(row => row.descriptor.id === 'gpt-5.5');
        expect(offered, JSON.stringify(resources)).toBeDefined();
        if (!offered) throw new Error('Home did not offer the source gpt-5.5 row');
        if (brokerOnly) {
          phase = 'catalog:broker-open';
          const session = await db.session.create({ data: { accountId: recipient.id, tag: crypto.randomUUID(),
            metadata: '{}', active: true } });
          await db.accessKey.create({ data: { accountId: recipient.id, machineId: worker.machineId, sessionId: session.id, data: '{}' } });
          expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { accountId: recipient.id, sessionId: session.id,
            authentication, intents: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: resource.id,
              expectedResourceRevision: resource.revision, teamId: team.id, deliveryMode: 'brokered' }] }))).toEqual({ ok: true });
          const response = await app.inject({ method: 'POST', url: PROVIDER_BROKER_OPEN_HTTP_PATH_V1,
            payload: { v: 1, resourceId: resource.id, expectedResourceRevision: resource.revision,
              initiatorMachineId: worker.machineId, consumer: { kind: 'session', sessionId: session.id },
              application: offered.application, modelId: offered.descriptor.id, sourceRevision: offered.sourceRevision } });
          const opened = ProviderBrokerOpenResponseV1Schema.parse(response.json());
          expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, authority: { payload: { resourceId: resource.id,
            sourceRevision: offered.sourceRevision, application: offered.application,
            target: { machineId: broker.id } } } });
          return;
        }
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
        api.setLocalMachineId(worker.machineId);
        const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device-local-key.json') });
        installProcessBoundary();
        // One process owns its applied registry for both independent ingress cases.
        for (const surface of ['cli', 'rpc'] as const) {
        phase = `${surface}:launch`;
        const requestStart = requests.length;
        const tracked = new Map<number, import('../types').TrackedSession>();
        const awaiters = new Map<number, (session: import('../types').TrackedSession) => void>();
        const resolvers = new Map<number, (result: import('@/session/shared/spawnSessionContract').SpawnSessionResult) => void>();
        const timeouts = new Map<number, NodeJS.Timeout>();
        let runner: Promise<void> | undefined;
        let sessionId = '';
        os.pid = process.pid + 1_000_000;
        const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
        const lifetime = new AbortController();
        os.runner = (args, environment) => { runner = (async () => {
          phase = `${surface}:startup-custody`;
          const startup = tracked.get(os.pid);
          if (!startup || await startup.acceptedSpawnMarkerGate === false) throw new Error('Daemon did not accept startup custody');
          const index = args.indexOf('--existing-session'); sessionId = args[index + 1]!;
          const attachPath = environment.HAPPIER_SESSION_ATTACH_FILE;
          if (!attachPath) throw new Error('Real daemon omitted protected attach');
          // Replace socket delivery only: the real Home presence owner admits
          // this process before its native runtime opens the Team broker.
          const presence = createSessionPublisherPresence();
          const publisherSocket = {};
          const registered = await presence.registerPublisher({ socket: publisherSocket,
            binding: { accountId: recipient.id, machineId: worker.machineId, sessionId },
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
          expect(registered, JSON.stringify(registered, (_key, value) => typeof value === 'bigint' ? String(value) : value))
            .toMatchObject({ status: 'registered' });
          phase = `${surface}:native-plan`;
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
          phase = `${surface}:native-runtime`;
          const presentation = createCurrentSessionPresentationHost({ session, signal: lifetime.signal });
          const runtime = await plan.config.createSessionRuntime?.({ directory, metadata: {}, machineId: worker.machineId,
            session, currentSessionPresentation: presentation.bindCurrentSession, transcriptSession: {}, messageBuffer: {},
            mcpServers: {}, permissionHandler: { cancelByPluginTurn: async () => undefined },
            getPermissionMode: () => 'safe-yolo', memoryRecallGuidanceEnabled: false } as never);
          if (!runtime) throw new Error('External runtime unavailable');
          const operations = (runtime as Readonly<{ operations: Readonly<{
            sendTurnPrompt(text: string, input: Readonly<{ turnId: string; localId: string; userMessageSeq: number }>): Promise<void>;
            subscribeRuntimeEvents(listener: (event: unknown) => void): (() => void) | void;
            resetOrDisposeRuntime(): Promise<void>;
          }> }>).operations;
          const events: unknown[] = [];
          const unsubscribe = operations.subscribeRuntimeEvents(event => events.push(event));
          try {
            phase = `${surface}:native-prompt`;
            await operations.sendTurnPrompt('TEAM_POOL_NATIVE_PROMPT', { turnId: 'team-turn', localId: 'team-input', userMessageSeq: 1 });
            expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', channel: 'assistant', text: 'TEAM_POOL_NATIVE_SENTINEL' }));
            answersObserved.push(surface);
          } finally {
            phase = `${surface}:native-close`;
            unsubscribe?.();
            await operations.resetOrDisposeRuntime();
            await presence.closePublisher({ socket: publisherSocket });
          }
          await expect(readFile(attachPath)).rejects.toMatchObject({ code: 'ENOENT' });
          phase = `${surface}:webhook`;
          // The real waiter projects the Home-created settlement already held
          // by daemon custody; a handwritten success would discard that receipt.
          const completed = tracked.get(os.pid);
          const acceptWebhook = awaiters.get(os.pid);
          if (!completed || !acceptWebhook) throw new Error('Daemon webhook custody is unavailable');
          acceptWebhook(completed);
        })(); void runner.catch(error => {
          runnerFailure = String(error);
          phase = `${surface}:runner-refused`;
          const timer = timeouts.get(os.pid); if (timer) clearTimeout(timer);
          resolvers.get(os.pid)?.({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: String(error) });
        }); };
        const handler = createSpawnNewSessionLifecycleActionHandler({ serverId: configuration.activeServerId,
          spawnSession: options => executeSpawnSessionRequest({ options, credentials, api,
            deviceLocalSecretStorage,
            activatePurposeBindings: worker.gateway!.purposeBindingOwner.activatePurposeBindings,
            activateSessionPurposeBindings: worker.gateway!.purposeBindingOwner.activateSessionPurposeBindings,
            connectedServicesMaterializationBaseDir: join(directory, 'connected-services'), connectedServiceRefreshCoordinator: null,
            connectedServiceQuotasCoordinator: null, connectedServiceRuntimeRegistry: { registerTarget() {} },
            pidToTrackedSession: tracked, pidToAwaiter: awaiters, pidToSpawnResultResolver: resolvers, pidToSpawnWebhookTimeout: timeouts,
            spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
            resolveCanonicalTrackedSessionId: pid => tracked.get(pid)?.happySessionId ?? '', onChildExited() {},
            processEnv: { ...process.env, RUN_NATIVE_API_KEY: '', HAPPIER_HOME_DIR: worker.happyHomeDir }, resolveProvidersFeatureEnabled: () => true }) });
        try {
          // Observe the logging boundary without replacing launch logic; a
          // cleanup refusal must not hide the original preparation diagnostic.
          const launchMessages: string[] = [];
          const writeDebug = logger.debug.bind(logger);
          const startupDiagnostics = vi.spyOn(logger, 'debug').mockImplementation((...args) => {
            if (/source-dev|Using regular|tmux|Spawn process phase/iu.test(args[0])) launchMessages.push(args[0]);
            writeDebug(...args);
          });
          readLaunchMessages = () => launchMessages;
          const launchPhases: unknown[] = [];
          const writeInfo = logger.infoFile.bind(logger);
          vi.spyOn(logger, 'infoFile').mockImplementation((...args) => {
            if (args[0] === '[DAEMON RUN] Spawn preparation phase') launchPhases.push(args[1]);
            writeInfo(...args);
          });
          readLaunchPhases = () => launchPhases;
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
          expect(runner, JSON.stringify({ result, diagnostics: startupDiagnostics.mock.calls.filter(([message]) =>
            /failed|refused|cleanup/iu.test(message)) })).toBeDefined();
          await expect(runner, JSON.stringify({ result, preparationFailures: startupDiagnostics.mock.calls.filter(([message]) =>
            message === '[DAEMON RUN] Session spawn failed after startup preparation') })).resolves.toBeUndefined();
          expect(result, JSON.stringify({ result, preparationFailures: startupDiagnostics.mock.calls.filter(([message]) =>
            message === '[DAEMON RUN] Session spawn failed after startup preparation') })).toMatchObject({ ok: true, result: { type: 'success' } });
          expect(requests.slice(requestStart)).toEqual([{ model: 'gpt-5.5', input: 'TEAM_POOL_NATIVE_PROMPT' }]);
          expect(await db.sessionTeamCredentialBinding.findMany({ where: { sessionId } })).toEqual(expect.arrayContaining([
            expect.objectContaining({ slotKind: 'provider_model:brokered', resourceId: resource.id }),
          ]));
          completedIngresses.push(surface);
        } finally { lifetime.abort(); for (const timer of timeouts.values()) clearTimeout(timer); await closeControlledRunner(); }
        }
      });
    } finally {
      await app.close(); await new Promise<void>(resolve => carrier.close(() => resolve()));
      await releaseSource?.();
      await source.controller.shutdown(); source.disposeCredentialBoundary(); await worker.cleanup();
      env.restore(); launchEnv.restore(); reloadConfiguration(); await rm(directory, { recursive: true, force: true });
    }
  });
  it('opens the offered source catalog revision through the real Home broker route and source runtime',
    ({ onTestFailed }) => runJourney(true, onTestFailed));
  it('runs gpt-5.5 with an answer distinct from its prompt through recipient confirmation, CLI/RPC ingress and protected attach',
    ({ onTestFailed }) => runJourney(false, onTestFailed));
});
