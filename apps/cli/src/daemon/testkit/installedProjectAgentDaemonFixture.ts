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
import { resolveRequesterSessionBootstrapFromCustody } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { createInstalledProjectAgentLaunchFixture } from './installedProjectAgentLaunchFixture';

export async function createInstalledProjectAgentDaemonFixture(readControl: () => Parameters<typeof startDaemonControlServer>[0] | null, bundledAgentId?: string, unassociated = false,
  authoredPlugin?: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins'][number],
  controller?: PluginReloadController,
  requesterOptions?: Pick<Parameters<typeof createRequesterSessionRuntimeContext>[0], 'resolveQualifiedConnectedAccountV4Support'>) {
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
  if (!retainedAgent) throw new Error(`Missing genuine retained Agent binding: ${JSON.stringify(plugin.registry.pluginDiagnosticsByPluginId['acme.project-launch'])}`);
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
  let requester: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let requesterRecoveryStage = 'not_requested';
  const daemon = await startDaemonSessionControlRuntime({ machineId: 'machine', serverId: 'session-home', serverBaseUrl: 'https://session-home.test',
    externalActionAccountId: 'custodian', credentials: { token: 'custodian-token', encryption: null }, api: {} as never,
    pluginRuntimeController: plugin.controller, connectedServiceRuntimeRegistry,
    daemonSessionMutationCustody: { stageTranscriptMessage: async () => { throw new Error('No transcript mutation'); },
      stageTranscriptEvent: async () => ({ persisted: true, delivered: true }) },
    connectedServicesMaterializationBaseDir: join(f.directory, 'connected-services'),
    getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
    pidToTrackedSession, pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
    getApiMachineForSessions: () => machine, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
    resolveRequesterSessionRuntimeContext: async (id, attribution) => {
      if (id !== sessionId) return null;
      // Startup precedes this fixture's initial runtime construction. A later
      // retired runtime must use real cold recovery, never a replacement stub.
      if (!requester) return null;
      if (await requester.isCurrent()) return requester;
      requesterRecoveryStage = 'bootstrap';
      const bootstrap = await resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: f.directory, serverId: 'session-home',
        serverHttpBaseUrl: 'https://session-home.test', sessionId: id, legacyOwnerCredentials: { token: 'requester-token', encryption: null },
        ...(attribution ? { expectedAttribution: attribution } : {}), machineAdmissionBoundary: {
          machineId: 'machine', daemonToken: 'custodian-token', isHomeCurrent: f.isHomeCurrent, readInstallation: () => f.installation } });
      if (!bootstrap) { requesterRecoveryStage = 'bootstrap_refused'; return null; }
      requesterRecoveryStage = 'runtime';
      requester = await createRequesterRuntime(bootstrap);
      requesterRecoveryStage = requester ? 'ready' : 'runtime_refused';
      if (requester) tracked.requesterSessionRuntimeContext = requester;
      return requester;
    },
    connectedServicesRestartRequestedPids: new Set(), beforeShutdown: async () => {}, onHappySessionWebhook: async () => {},
    requestShutdown() {}, processEnv: { NODE_ENV: 'test' } });
  onTestFinished(() => daemon.stopControlServer());
  const createRequesterRuntime = (bootstrap: typeof f.bootstrap) => createRequesterSessionRuntimeContext({ bootstrap,
    activeServerDir: f.directory, connectedServicesMaterializationBaseDir: join(f.directory, 'requester-connected-services'),
    resolveQualifiedConnectedAccountV4Support: requesterOptions?.resolveQualifiedConnectedAccountV4Support ?? (() => 'indeterminate'),
    coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'project-runtime', happyHomeDir: f.directory,
      logger: { debug() {}, info() {}, warn() {} }, processEnv: { NODE_ENV: 'test',
        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
      pidToTrackedSession, connectedServiceRuntimeRegistry,
      connectedServiceAuthGroupPreTurnSwitchCoordinator: daemon.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
  requester = await createRequesterRuntime(f.bootstrap);
  if (!requester) throw new Error('Missing requester runtime');
  onTestFinished(() => requester?.dispose());
  tracked.requesterSessionRuntimeContext = requester;
  const services = readControl()?.agentRuntimeDaemonServices;
  if (!services) throw new Error('Missing production private dispatcher');
  let sequence = 0;
  const dispatch = async (operation: AgentRuntimeDaemonServiceRequestV1['operation'], executionRunSnapshotId?: string) => AgentRuntimeDaemonServiceResponseV1Schema.parse(await services.dispatch(
    AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1, context: { token: 'a'.repeat(43), sessionId,
      ...(executionRunSnapshotId ? { executionRunSnapshotId } : {}) }, operation }),
    { sessionId, runner, retainedAgent, trackedSession: tracked, invocationContext: tracked.runnerAgentInvocationContext!,
      isCurrent: async () => true, signal }));
  const operationBase = (invocationId = 'cold-invocation') => ({ invocationId, requestId: `request-${++sequence}` });
  return { ...fixture, signal, cwd, dispatch, operationBase, sessionId, retainedAgent, requester, runner, tracked, plugin, pidToTrackedSession,
    readRequesterRecoveryStage: () => requesterRecoveryStage,
    async replaceRequesterRuntime() {
      const replacement = await createRequesterRuntime(await f.createBootstrap());
      if (!replacement) throw new Error('Missing replacement requester runtime');
      const previous = requester;
      requester = replacement;
      await previous?.dispose();
      return replacement;
    },
  };
}
