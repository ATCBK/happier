import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { prepareForegroundAgentRuntimeBootstrapForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { SessionHostBridge } from './SessionHostBridge';

afterEach(() => { vi.unstubAllGlobals(); reloadConfiguration(); });

it('claims replacement foreground authority at deferred native preparation while retaining the initial Agent bootstrap', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-foreground-source-authority-'));
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  env.patch({ HAPPIER_HOME_DIR: home }); reloadConfiguration();
  const oldTitle = process.title;
  process.title = join(home, 'src', 'index.ts');
  const agentId = 'acme.foreground-source/fixture';
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home, plugins: [{
    manifest: createPluginManifestV2Fixture({ id: 'acme.foreground-source', contributes: { agents: [{
      id: 'fixture', title: 'Foreground source fixture', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
    }] } }), files: {
      'runtime.mjs': 'export function createRuntime() { throw new Error("Daemon refusal must precede Agent effects"); }',
      'daemon.mjs': 'import { createRuntime } from "./runtime.mjs"; export function activate(api) { api.agents.register("fixture", createRuntime, { sessionRunnerFactory: { module: "./runtime.mjs", export: "createRuntime", runtimeApiVersion: 1 } }); }',
    },
  }] });
  const bootstrap = await prepareForegroundAgentRuntimeBootstrapForLease({ target: { kind: 'backend', backendId: agentId }, lease: fixture.lease });
  if (!bootstrap) throw new Error('Physical Agent bootstrap unavailable');
  try {
    let activeAuthorityPath = bootstrap.authorization.authorityFilePath;
    const plan = await new SessionHostBridge().createSessionRuntime(agentId, {
      credentials: { token: 'source-fixture-token', encryption: null }, happyHomeDir: home, directory: home, startedBy: 'terminal',
    }, { agentRuntimeRunnerBootstrapFilePath: bootstrap.authorization.bootstrapFilePath,
      get agentRuntimeDaemonServiceAuthorityFilePath() { return activeAuthorityPath; } });
    const binding = fixture.registry.agentRuntimesByAgentId.get(agentId)?.sessionRunnerFactoryBinding;
    const identity = await readProcessIdentityByPid(process.pid);
    if (!binding || !identity?.processStartTimeMs) throw new Error('Physical Agent or runner identity unavailable');
    const entrypoint = resolveSessionRunnerEntrypointIdentityFromProcessCommand(identity.command);
    if (entrypoint.status !== 'known') throw new Error('Runner entrypoint identity unavailable');
    const replacementPath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: home, publicReleaseRing: configuration.publicReleaseRing });
    expect(replacementPath).not.toBe(activeAuthorityPath);
    const sessionId = 'foreground-retry-session';
    const issued = await publishAgentRuntimeDaemonServiceAuthority({ happyHomeDir: home,
      publicReleaseRing: configuration.publicReleaseRing, path: replacementPath, sessionId, retainedAgent: binding,
      runner: { pid: process.pid, processStartTimeMs: identity.processStartTimeMs,
        processCommandHash: hashProcessCommand(identity.command), snapshotIdentity: entrypoint.comparableId },
      httpPort: 44124, capability: 'B'.repeat(43) });
    activeAuthorityPath = replacementPath;
    const daemonRequests: ReturnType<typeof AgentRuntimeDaemonServiceRequestV1Schema.parse>[] = [];
    // Refuse at the daemon HTTP boundary after the real deferred source has
    // claimed authority. No native Agent effect is needed for this path proof.
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
      daemonRequests.push(AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init.body))));
      return new Response(JSON.stringify({ ok: false, error: {
        code: 'foreground_source_fixture_stop', message: 'foreground_source_fixture_stop',
      } }), { status: 200 });
    });
    const metadata = createTestMetadata({ path: home, machineId: 'foreground-source-machine' });
    const session = createMutableApiSessionClientFixture({ sessionId, metadata });
    const presentationLifetime = new AbortController();
    const presentation = createCurrentSessionPresentationHost({ session, signal: presentationLifetime.signal });
    const createRuntime = plan.config.createSessionRuntime;
    if (!createRuntime) throw new Error('Native Session runtime factory unavailable');
    try {
      const failure = await Promise.resolve(createRuntime({ directory: home, metadata, machineId: 'foreground-source-machine', agentTargetKey: `agent:${agentId}`,
        session, transcriptSession: session, messageBuffer: new MessageBuffer(), mcpServers: {},
        currentSessionPresentation: presentation.bindCurrentSession,
        permissionHandler: createProviderEnforcedPermissionHandler({ session, logPrefix: '[foreground-source-fixture]' }),
        getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
        runnerProcessIdentity: { pid: process.pid, processStartTimeMs: identity.processStartTimeMs }, startupModelSelection: null,
        runWithTerminalModelSelection: async effect => ({ status: 'completed', value: await effect(null,
          async localEffect => ({ status: 'completed', value: await localEffect() })) }),
      })).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(daemonRequests, failure instanceof Error ? failure.message : String(failure)).toEqual(expect.arrayContaining([expect.objectContaining({ context: {
        token: issued.document.capability, sessionId,
      } })]));
    } finally { presentationLifetime.abort(); presentation.retire(); }
  } finally {
    await bootstrap.cleanupBootstrapFiles(); await fixture.dispose(); process.title = oldTitle;
    env.restore(); reloadConfiguration(); await rm(home, { recursive: true, force: true });
  }
}, 120_000);
