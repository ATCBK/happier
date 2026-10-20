import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { StoredSessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { readStoredCredentials, writeCredentialsTokenOnly, writeDaemonState } from '@/persistence';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { projectPath } from '@/projectPath';
import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import { prepareForegroundAgentRuntimeBootstrapForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { readRunnerAgentSessionBootstrap } from '@/agent/runtime/session/process/runnerAgentSessionBootstrap';
import { FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH, FOREGROUND_AGENT_RUNTIME_RELEASE_PATH,
  ForegroundAgentRuntimeAdmissionRequestV1Schema, ForegroundAgentRuntimeAdmissionResponseV1Schema } from '@/daemon/agentRuntime/foregroundAdmissionContract';
import { runBackendSessionCliCommand } from './runBackendSessionCliCommand';

afterEach(() => { vi.restoreAllMocks(); reloadConfiguration(); });

describe('foreground CLI runner authority scope', () => {
  it.each([
    { prior: undefined, definitionId: undefined },
    { prior: '', definitionId: undefined },
    { prior: 'previous-invocation', definitionId: undefined },
    { prior: undefined, definitionId: 'definition-a' },
    { prior: undefined, definitionId: 'definition-b' },
  ])('exposes the admitted bootstrap through real Session creation and restores prior paths ($prior / $definitionId)', async ({ prior, definitionId }) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-foreground-cli-authority-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL',
      'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SESSION_AUTOSTART_DAEMON',
      HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY, HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]);
    const previous = { [HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]: prior && `${prior}.bootstrap`,
      [HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]: prior && `${prior}.authority` };
    env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'foreground-fixture',
      HAPPIER_SESSION_AUTOSTART_DAEMON: '0', ...previous });
    let agentId = 'acme.foreground/fixture';
    const agentTarget = definitionId === undefined ? undefined : {
      kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId,
    };
    let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    const authorizations: NonNullable<Awaited<ReturnType<typeof prepareForegroundAgentRuntimeBootstrapForLease>>>[] = [];
    let sessionCreateEnvironment: Readonly<Record<string, string | undefined>> | null = null;
    let sessionCreateBootstrapAgent: string | null = null;
    let sessionCreateModelSelection: unknown = null;
    let releaseObserved = false;
    const requests: string[] = [];
    const boundaryErrors: unknown[] = [];
    // This is the daemon/Home HTTP boundary. CLI parsing, credentials, engine
    // resolution, physical Agent admission and Session construction stay real.
    const server = createServer(async (request, response) => {
      const respond = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const path = request.url ?? '';
      requests.push(path);
      try {
        let text = '';
        for await (const chunk of request) text += String(chunk);
        if (path === '/ping') return respond(200, { success: true });
        if (path === FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH) {
          const admission = ForegroundAgentRuntimeAdmissionRequestV1Schema.parse(JSON.parse(text));
          if (!fixture) throw new Error('Physical Agent fixture unavailable');
          const bootstrap = await prepareForegroundAgentRuntimeBootstrapForLease({ target: admission.backendTarget, lease: fixture.lease,
            ...(admission.runtimeDescriptorV1 ? { launch: { runtimeDescriptorV1: admission.runtimeDescriptorV1 } } : {}) });
          if (!bootstrap) throw new Error('Physical Agent bootstrap unavailable');
          authorizations.push(bootstrap);
          return respond(200, ForegroundAgentRuntimeAdmissionResponseV1Schema.parse({ ok: true, capability: {
            attemptId: admission.attemptId, admissionFilePath: bootstrap.authorization.foregroundAdmissionFilePath,
            bootstrapFilePath: bootstrap.authorization.bootstrapFilePath, authorityFilePath: bootstrap.authorization.authorityFilePath,
            descriptor: bootstrap.authorization.descriptor,
          }, launchPolicy: { reservedEnvironmentVariableNames: [], profileSecretRequirementNamesMissingBinding: [] } }));
        }
        if (path === FOREGROUND_AGENT_RUNTIME_RELEASE_PATH) { releaseObserved = true; return respond(200, { ok: true }); }
        if (path === '/v1/features') return respond(200, FeaturesResponseSchema.parse({ features: {},
          capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }));
        if (path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness') {
          return respond(200, createAccountEncryptionCurrentnessFixture());
        }
        if (path === '/v1/sessions') {
          const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(JSON.parse(text).ownerMetadata);
          if (owner.t !== 'plain') throw new Error('Expected the plain fixture Account');
          sessionCreateModelSelection = owner.v.runtime?.modelSelectionIntentV1?.selection ?? null;
          sessionCreateEnvironment = {
            [HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]: process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY],
            [HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]: process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY],
          };
          const bootstrapPath = process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY];
          if (bootstrapPath && bootstrapPath !== previous[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]) {
            sessionCreateBootstrapAgent = (await readRunnerAgentSessionBootstrap(bootstrapPath)).descriptor.agentId;
          }
          // A real Home refusal stops before realtime sockets or Agent effects.
          return respond(403, { error: 'foreground-fixture-refusal' });
        }
        return respond(404, { error: 'unexpected-fixture-request' });
      } catch (error) { boundaryErrors.push(error); respond(500, { error: 'fixture-boundary-failure' }); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
    const origin = `http://127.0.0.1:${address.port}`;
    env.patch({ HAPPIER_SERVER_URL: origin, HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: origin });
    reloadConfiguration();
    try {
      await writeCredentialsTokenOnly({ token: 'foreground-fixture-token' });
      fixture = agentTarget ? await createAdmittedPluginRuntimeFixture({ happyHomeDir: home,
        runtimeOptions: { pluginIds: [agentTarget.identity.pluginId] } }) : await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home, plugins: [{
        manifest: createPluginManifestV2Fixture({ id: 'acme.foreground', contributes: { agents: [{
          id: 'fixture', title: 'Foreground CLI fixture', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }] } }), files: {
          'runtime.mjs': 'export function createRuntime() { throw new Error("Home refusal must precede Agent effects"); }',
          'daemon.mjs': 'import { createRuntime } from "./runtime.mjs"; export function activate(api) { api.agents.register("fixture", createRuntime, { sessionRunnerFactory: { module: "./runtime.mjs", export: "createRuntime", runtimeApiVersion: 1 } }); }',
        },
      }] });
      if (agentTarget) {
        const contribution = [...fixture.registry.contributes.agentDefinitionsById.values()]
          .find(value => value.identity?.pluginId === agentTarget.identity.pluginId
            && value.identity.localId === agentTarget.identity.localId);
        if (!contribution) throw new Error('Actual configured Agent contribution missing');
        agentId = contribution.id;
        const credentials = await readStoredCredentials();
        if (!credentials) throw new Error('Installed fixture credentials missing');
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
          settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
          acpCatalog: { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: agentTarget.definitionId, name: agentTarget.definitionId, title: agentTarget.definitionId,
            launch: { kind: 'command', command: 'unreachable-before-home-refusal', args: [] }, env: {}, capabilities: {}, createdAt: 1, updatedAt: 1,
          }] }) } });
      }
      writeDaemonState({ pid: process.pid, httpPort: address.port, controlToken: 'fixture-control-token', startedAt: Date.now(),
        startedWithCliVersion: resolveComparableCliVersion({ fallbackVersion: configuration.currentCliVersion,
          projectRootPath: projectPath(), readFileSyncImpl: readFileSync }) });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const processExit = vi.spyOn(process, 'exit').mockImplementation((() => {
        expect(process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]).toBe(previous[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]);
        expect(process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]).toBe(previous[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]);
        throw new Error('foreground-command-exit');
      }) as never);
      await expect(runBackendSessionCliCommand({ context: { args: agentTarget ? ['--model', 'fixture-native-model'] : [], rawArgv: [], terminalRuntime: null },
        backendIdForSessionRuntime: agentId, runtimeAuthorityAgentId: agentId,
        ...(agentTarget ? { resolveExtraOptions: () => ({ agentTarget,
          runtimeDescriptorV1: { v: 1 as const, agentId, agent: { definitionId: agentTarget.definitionId } } }) } : {}),
      })).rejects.toThrow('foreground-command-exit');
      expect(boundaryErrors).toEqual([]);
      expect(requests, vi.mocked(console.error).mock.calls.map(call => call.join(' ')).join('\n')).toContain('/v1/sessions');
      expect(authorizations).toHaveLength(1);
      expect(sessionCreateEnvironment).toEqual(authorizations[0]!.childEnv);
      expect(sessionCreateBootstrapAgent).toBe(agentId);
      if (agentTarget) {
        expect(sessionCreateModelSelection).toMatchObject({
          agentTargetKey: buildBackendTargetKeyV2(agentTarget), modelId: 'fixture-native-model',
        });
        expect(authorizations[0]!.authorization.descriptor.backendId).toBe(agentId);
      }
      expect(releaseObserved).toBe(true);
      expect(processExit).toHaveBeenCalledWith(1);
      expect(process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]).toBe(previous[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]);
      expect(process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]).toBe(previous[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]);
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
      for (const authorization of authorizations) await authorization.cleanupBootstrapFiles();
      await fixture?.dispose();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      env.restore(); reloadConfiguration(); await rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});
