import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, onTestFinished } from 'vitest';
import { readStoredCredentialsForServerId, writeCredentialsTokenOnly, writeStoredCredentialsForServerId } from '@/persistence';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema, type AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import type { TrackedSession } from '@/daemon/types';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginReloadController, type PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createRequesterSessionRuntimeContextResolver, releaseUnretainedRequesterSessionRuntimeContext,
  resolveRequesterSessionBootstrapFromCustody } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { createInstalledProjectAgentLaunchFixture } from './installedProjectAgentLaunchFixture';

export async function createInstalledProjectAgentDaemonFixture(readControl: () => Parameters<typeof startDaemonControlServer>[0] | null, bundledAgentId?: string, unassociated = false,
  authoredPlugin?: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins'][number],
  controller?: PluginReloadController,
  requesterOptions?: Pick<Parameters<typeof createRequesterSessionRuntimeContext>[0], 'resolveQualifiedConnectedAccountV4Support'>
    & Pick<Parameters<typeof startDaemonSessionControlRuntime>[0], 'resolveCurrentMachineExecutionOriginContext' | 'processEnv' | 'openTeamCredentialProviderBinding'>
    & Partial<Pick<Parameters<typeof startDaemonSessionControlRuntime>[0], 'credentials'>>) {
  const daemonCredentials = requesterOptions?.credentials ?? { token: 'custodian-token', encryption: null };
  const accountActionCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester',
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const fixture = await createInstalledProjectAgentLaunchFixture({ accountActionCredentials });
  const { f, machine } = fixture;
  const signal: AbortSignal = fixture.signal;
  const runtimeController = controller ?? createPluginReloadController({ happyHomeDir: f.directory });
  const cwd = unassociated ? join(f.directory, 'fresh-unassociated') : fixture.cwd;
  if (unassociated) await mkdir(cwd);
  await writeCredentialsTokenOnly(accountActionCredentials);
  await writeStoredCredentialsForServerId('session-home', accountActionCredentials);
  expect((await readStoredCredentialsForServerId('session-home'))?.token === accountActionCredentials.token,
    'The Account Action fixture must retain its canonical Home credentials').toBe(true);
  const plugin = bundledAgentId ? await createAdmittedPluginRuntimeFixture({ happyHomeDir: f.directory,
    controller: runtimeController, runtimeOptions: { pluginIds: [`happier.agent.${bundledAgentId}`] } })
    : await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: f.directory, controller: runtimeController,
    plugins: [authoredPlugin ?? { manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', contributes: { agents: [{ id: 'agent', title: 'Project launch Agent',
      runtime: { kind: 'custom' }, primary: 'sessions', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }] } }),
      files: { 'agent.mjs': `export function factory() { return { sessions: { open() { throw new Error('No Agent open at authorization'); } } }; }`,
        'daemon.mjs': `import { factory } from './agent.mjs';
        export function activate(api) { api.agents.register('agent', factory, {
          sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } }); }` } }] });
  onTestFinished(() => plugin.dispose());
  const retainedAgent = plugin.registry.agentRuntimesByAgentId.get(bundledAgentId ?? 'acme.project-launch/agent')?.sessionRunnerFactoryBinding;
  if (!retainedAgent) throw new Error(`Missing genuine retained Agent binding: ${JSON.stringify(plugin.registry.pluginDiagnosticsByPluginId[bundledAgentId ? `happier.agent.${bundledAgentId}` : 'acme.project-launch'])}`);
  const runner = { pid: process.pid, processStartTimeMs: 1, processCommandHash: 'a'.repeat(64), snapshotIdentity: 'fixture-runner' };
  const sessionId = 'project-session';
  const tracked: TrackedSession = { pid: process.pid, sessionRunnerPid: process.pid, startedBy: 'daemon', happySessionId: sessionId,
    requesterWorkAttributionV1: f.bootstrap.attribution,
    processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
    runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
    runnerAgentBootstrapIdentity: { agentId: retainedAgent.agentId, backendId: retainedAgent.agentId },
    runnerAgentInvocationContext: { cwd, environment: {}, providerBindingActive: false },
    spawnOptions: { directory: cwd, backendTarget: { kind: 'backend', backendId: retainedAgent.agentId } } };
  const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
  const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
  let createRequesterRuntime: ((bootstrap: typeof f.bootstrap) => ReturnType<typeof createRequesterSessionRuntimeContext>) | null = null;
  let requesterRecoveryStage = 'not_requested';
  const resolveRequesterRuntime = createRequesterSessionRuntimeContextResolver({
    trackedSessions: pidToTrackedSession,
    // Startup precedes construction of the real requester runtime factory.
    getCreateRuntime: () => createRequesterRuntime,
    recoverBootstrap: async ({ sessionId: id, attribution }) => {
      if (id !== sessionId) return null;
      requesterRecoveryStage = 'bootstrap';
      const bootstrap = await resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: f.directory, serverId: 'session-home',
        serverHttpBaseUrl: 'https://session-home.test', sessionId: id, legacyOwnerCredentials: f.bootstrap.credentials,
        ...(attribution ? { expectedAttribution: attribution } : {}), machineAdmissionBoundary: {
          machineId: 'machine', daemonToken: daemonCredentials.token, isHomeCurrent: f.isHomeCurrent, readInstallation: () => f.installation } });
      if (!bootstrap) requesterRecoveryStage = 'bootstrap_refused';
      return bootstrap;
    },
  });
  const daemon = await startDaemonSessionControlRuntime({ machineId: 'machine', serverId: 'session-home', serverBaseUrl: 'https://session-home.test',
    resolveCurrentMachineExecutionOriginContext: requesterOptions?.resolveCurrentMachineExecutionOriginContext,
    openTeamCredentialProviderBinding: requesterOptions?.openTeamCredentialProviderBinding,
    externalActionAccountId: 'custodian', credentials: daemonCredentials, api: {} as never,
    deviceLocalSecretStorage: await readOrCreateDeviceLocalSecretStorage({ path: join(f.directory, 'fixture-device-secret') }),
    pluginRuntimeController: plugin.controller, connectedServiceRuntimeRegistry,
    daemonSessionMutationCustody: { stageTranscriptMessage: async () => { throw new Error('No transcript mutation'); },
      stageTranscriptEvent: async () => ({ persisted: true, delivered: true }) },
    connectedServicesMaterializationBaseDir: join(f.directory, 'connected-services'),
    getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
    pidToTrackedSession, pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
    getApiMachineForSessions: () => machine, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
    resolveRequesterSessionRuntimeContext: resolveRequesterRuntime,
    releaseRequesterSessionRuntimeContext: async context => {
      await releaseUnretainedRequesterSessionRuntimeContext(context,
        [...pidToTrackedSession.values()].map(session => session.requesterSessionRuntimeContext));
    },
    connectedServicesRestartRequestedPids: new Set(), beforeShutdown: async () => {}, onHappySessionWebhook: async () => {},
    requestShutdown() {}, processEnv: { NODE_ENV: 'test', ...requesterOptions?.processEnv } });
  onTestFinished(() => daemon.stopControlServer());
  createRequesterRuntime = async bootstrap => {
    requesterRecoveryStage = 'runtime';
    const context = await createRequesterSessionRuntimeContext({ bootstrap,
      activeServerDir: f.directory, connectedServicesMaterializationBaseDir: join(f.directory, 'requester-connected-services'),
      resolveQualifiedConnectedAccountV4Support: requesterOptions?.resolveQualifiedConnectedAccountV4Support ?? (() => 'indeterminate'),
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'project-runtime', happyHomeDir: f.directory,
        logger: { debug() {}, info() {}, warn() {} }, processEnv: { NODE_ENV: 'test',
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession, connectedServiceRuntimeRegistry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: daemon.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (context) onTestFinished(() => context.dispose());
    requesterRecoveryStage = context ? 'ready' : 'runtime_refused';
    return context;
  };
  const requester = await resolveRequesterRuntime(sessionId, f.bootstrap.attribution);
  if (!requester) throw new Error('Missing requester runtime');
  const services = readControl()?.agentRuntimeDaemonServices;
  if (!services) throw new Error('Missing production private dispatcher');
  let sequence = 0;
  const dispatch = async (operation: AgentRuntimeDaemonServiceRequestV1['operation'], executionRunSnapshotId?: string) => AgentRuntimeDaemonServiceResponseV1Schema.parse(await services.dispatch(
    AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1, context: { token: 'a'.repeat(43), sessionId,
      ...(executionRunSnapshotId ? { executionRunSnapshotId } : {}) }, operation }),
    { sessionId, runner, retainedAgent, trackedSession: tracked, invocationContext: tracked.runnerAgentInvocationContext!,
      isCurrent: async () => true, signal }));
  const operationBase = (invocationId = 'cold-invocation') => ({ invocationId, requestId: `request-${++sequence}` });
  return { ...fixture, signal, cwd, dispatch, operationBase, sessionId, retainedAgent, requester, runner, tracked, plugin, pidToTrackedSession, daemon,
    resolveRequesterRuntime,
    readRequesterRecoveryStage: () => requesterRecoveryStage,
    async replaceRequesterRuntime() {
      await tracked.requesterSessionRuntimeContext?.dispose();
      const replacement = await resolveRequesterRuntime(sessionId, tracked.requesterWorkAttributionV1);
      if (!replacement) throw new Error('Missing replacement requester runtime');
      return replacement;
    },
  };
}
