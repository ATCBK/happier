import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountSettingsParse } from '@happier-dev/protocol';
import { AgentExecutionTargetV1Schema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { configuration } from '@/configuration';
import { ApiClient } from '@/api/api';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  commitActiveAcpCatalog, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { AgentRuntimeRunnerBootstrapV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { resolveAccountConfiguredAcpLaunchForAgent } from '@/agent/runtime/registry/engineRegistry/accountConfiguredAcp';
import { createCustomAcpAdmissionRuntimeFixture } from './customAcpAdmission.testkit';
import { executeSpawnSessionRequest, type ExecuteSpawnSessionRequestParams } from './executeSpawnSessionRequest';
import { SpawnSessionControlErrorResponseSchema, projectSpawnSessionControlErrorResponse } from '@/session/shared/spawnSessionContract';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';

const storage = vi.hoisted(() => ({ home: '', persistedToken: 'df38-owner-token',
  credentials: { token: 'df38-owner-token', encryption: null } }));
// OS/environment boundaries only: real admission, catalog, activation, Account custody,
// launch resolution, bootstrap publication and its strict consumer remain in the path.
vi.mock('@/configuration', async importOriginal => ({
  ...await importOriginal<typeof import('@/configuration')>(),
  configuration: { get happyHomeDir() { return storage.home; },
    get activeServerDir() { return join(storage.home, 'servers', 'active'); },
    activeServerId: 'df38-home', serverUrl: 'http://df38.example.test',
    apiServerUrl: 'http://df38.example.test', publicServerUrl: 'http://df38.example.test',
    publicReleaseRing: 'stable' },
}));
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ ...storage.credentials, token: storage.persistedToken }),
  readSettings: async () => ({ machineId: 'df38-machine' }),
}));

let runtime: Awaited<ReturnType<typeof createCustomAcpAdmissionRuntimeFixture>>;
let api: ApiClient;
beforeAll(async () => {
  storage.home = await mkdtemp(join(tmpdir(), 'happier-df38-spawn-'));
  runtime = await createCustomAcpAdmissionRuntimeFixture();
  api = await ApiClient.create(storage.credentials);
});
afterAll(async () => {
  await runtime?.dispose();
  resetActiveAccountSettingsSnapshotForTests();
  await rm(storage.home, { recursive: true, force: true });
});
beforeEach(() => {
  storage.persistedToken = storage.credentials.token;
  resetActiveAccountSettingsSnapshotForTests();
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
    scopeKey: resolveAccountSettingsScopeKey(storage.credentials), settingsVersion: 4,
    loadedAtMs: 1, settingsSecretsReadKeys: [],
    acpCatalog: { status: 'ready', revision: 4, record: AcpCatalogRecordV1Schema.parse({ v: 1,
      definitions: ['alpha', 'beta', 'missing'].map(id => ({ id, name: id, title: id,
        launch: { kind: 'command', command: id === 'missing' ? join(storage.home, 'missing-goose') : process.execPath, args: [`${id}.mjs`] },
        env: { DF38_SELECTION: { t: 'literal', v: id } },
        capabilities: { supportsLoadSession: true, supportsModes: 'unknown', supportsModels: 'unknown',
          supportsConfigOptions: 'unknown', promptImageSupport: 'no' }, createdAt: 1, updatedAt: 2 })) }) } });
});

function params(definitionId: string, beforeSessionRunnerLaunch: () => Promise<boolean>): ExecuteSpawnSessionRequestParams {
  return { options: { directory: storage.home,
      agentTarget: AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId }),
      beforeSessionRunnerLaunch }, credentials: storage.credentials,
    api,
    connectedServicesMaterializationBaseDir: join(storage.home, 'connected-services'),
    connectedServiceRefreshCoordinator: null, connectedServiceQuotasCoordinator: null,
    connectedServiceRuntimeRegistry: { registerTarget: () => {} },
    pidToTrackedSession: new Map(), pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(), spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
    resolveCanonicalTrackedSessionId: () => '', onChildExited: () => {},
    processEnv: { ...process.env } };
}

describe('Custom ACP fresh daemon launch composition', () => {
  it('carries each qualified definition through execution surfaces and bootstrap into its exact spawn specification', async () => {
    for (const definitionId of ['alpha', 'beta']) {
      let reachedLaunch = false;
      const result = await executeSpawnSessionRequest(params(definitionId, async () => {
        const bootstrapDir = join(configuration.happyHomeDir, 'tmp', 'runner-agent-session-bootstraps');
        const files = await readdir(bootstrapDir);
        expect(files).toHaveLength(1);
        const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(join(bootstrapDir, files[0]!), 'utf8')));
        const descriptor = RuntimeDescriptorV1Schema.parse(bootstrap.launch?.runtimeDescriptorV1);
        expect(descriptor.agent.definitionId).toBe(definitionId);
        const launch = await resolveAccountConfiguredAcpLaunchForAgent({ identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
          startupRuntimeDescriptorV1: descriptor });
        expect(await launch?.resolveHostLaunch({ cwd: storage.home })).toMatchObject({
          command: process.execPath, args: [`${definitionId}.mjs`], env: { DF38_SELECTION: definitionId } });
        reachedLaunch = true;
        // The production pre-launch custody hook refuses physical execution;
        // the test observes the real spec without launching another daemon.
        return false;
      }));
      expect({ reachedLaunch, result }, JSON.stringify(result)).toMatchObject({ reachedLaunch: true,
        result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
    }
  });

  it('retains a thrown typed launch cause instead of an opaque spawn failure', async () => {
    const result = await executeSpawnSessionRequest(params('alpha', async () => {
      throw Object.assign(new Error('Launch permission refused'), { code: 'EACCES' });
    }));
    expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
      errorDetail: { kind: 'launch_error', code: 'EACCES', message: 'Launch permission refused' } });
    if (result.type !== 'error') throw new Error('Expected a launch failure');
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(result));
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }))).toMatchObject({ code: 'spawn_failed', launchError: { code: 'EACCES', message: 'Launch permission refused' } });
  });

  it('refuses a missing selected executable with the Agent-not-installed code before runner launch', async () => {
    const result = await executeSpawnSessionRequest(params('missing', async () => {
      throw new Error('A missing executable must never reach runner admission');
    }));
    expect(result).toMatchObject({ type: 'error', errorCode: 'agent_cli_missing', agentId: 'custom-acp' });
  });

  it('supplies a cause code for an unexpected uncoded launch failure', async () => {
    const result = await executeSpawnSessionRequest(params('alpha', async () => { throw new Error('Unexpected launch failure'); }));
    expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
      errorDetail: { kind: 'launch_error', code: 'SPAWN_FAILED', message: 'Unexpected launch failure' } });
  });

  it('preserves the actual Account ACP launch-resolution refusal code', async () => {
    storage.persistedToken = 'foreign-account-token';
    const result = await executeSpawnSessionRequest(params('alpha', async () => {
      throw new Error('Unavailable Account launch custody must not reach runner admission');
    }));
    expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
      errorDetail: { kind: 'launch_error', code: 'ACP_CATALOG_UNAVAILABLE', message: expect.stringContaining('credentials-unavailable') } });
  });

  it('validates the selected command on the supplied launch PATH', async () => {
    const bin = await mkdtemp(join(storage.home, 'bin-'));
    const command = 'df38-path-only-agent';
    await writeExecutableShim({ dir: bin, fileName: command,
      contents: process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n' });
    const snapshot = getActiveAccountSettingsSnapshot()!;
    if (snapshot.acpCatalog?.status !== 'ready') throw new Error('Expected the ready launch catalog');
    commitActiveAcpCatalog({ scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { ...snapshot.acpCatalog, revision: 5, record: AcpCatalogRecordV1Schema.parse({ v: 1,
        definitions: snapshot.acpCatalog.record.definitions.map(definition => definition.id === 'alpha'
          ? { ...definition, launch: { kind: 'command', command, args: [] } } : definition) }) } });
    let reached = false;
    const input = params('alpha', async () => { reached = true; return false; });
    const result = await executeSpawnSessionRequest({ ...input,
      processEnv: { ...input.processEnv, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` } });
    expect({ reached, result }, JSON.stringify(result)).toMatchObject({ reached: true,
      result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
  });

  it('validates a relative configured command from the Session directory', async () => {
    const command = 'df38-relative-agent';
    await writeExecutableShim({ dir: storage.home, fileName: command,
      contents: process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n' });
    const snapshot = getActiveAccountSettingsSnapshot()!;
    if (snapshot.acpCatalog?.status !== 'ready') throw new Error('Expected the ready launch catalog');
    commitActiveAcpCatalog({ scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { ...snapshot.acpCatalog, revision: 5, record: AcpCatalogRecordV1Schema.parse({ v: 1,
        definitions: snapshot.acpCatalog.record.definitions.map(definition => definition.id === 'alpha'
          ? { ...definition, launch: { kind: 'command', command: `./${command}`, args: [] } } : definition) }) } });
    let reached = false;
    const result = await executeSpawnSessionRequest(params('alpha', async () => { reached = true; return false; }));
    expect({ reached, result }, JSON.stringify(result)).toMatchObject({ reached: true,
      result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
  });
});
