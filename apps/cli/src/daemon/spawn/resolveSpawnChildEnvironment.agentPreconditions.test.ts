import { describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { PluginManifestV2Schema, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as CODEX_MANIFEST } from '@happier-dev/plugins-codex/manifest';
import { PLUGIN_MANIFEST as ANTIGRAVITY_MANIFEST } from '@happier-dev/plugins-antigravity/manifest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { projectBuiltInAgents } from '@/plugins/projection/registry/builtIn/agents';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from '@/plugins/projection/registry/sources/generatedBundledPlugins';
import { projectAgentCliAuthCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { prepareDaemonSpawnChildEnvironment } from './prepareDaemonSpawnChildEnvironment';
import { commitDaemonLaunchSession } from './commitDaemonLaunchSession';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

async function createPinnedSpawnAgentRegistry(): Promise<ResolvedExecutablePluginRuntimeRegistry> {
  const manifests = [CODEX_MANIFEST, ANTIGRAVITY_MANIFEST].map((manifest) => PluginManifestV2Schema.parse(manifest));
  const agents = projectBuiltInAgents({
    manifestAgents: manifests.flatMap((manifest) => manifest.contributes.agents.map((definition) => ({
      ...projectManifestAgentContribution({
        definition, pluginId: manifest.id, provenance: 'first_party', source: { kind: 'bundled' },
        systemTools: manifest.contributes.systemTools,
      }),
      hostAccess: manifest.hostAccess,
    }))),
    registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS.filter((binding) => (
      manifests.some((manifest) => manifest.id === binding.identity.pluginId)
    )),
  }).map((agent) => {
    if (agent.id !== 'codex') return agent;
    const manifest = manifests.find((item) => item.id === agent.pluginId);
    const cli = agent.richDefinition?.definition.cli;
    if (!manifest || !cli) throw new Error('Codex fixture needs its declared CLI metadata');
    return { ...agent, catalogEntry: {
      ...agent.catalogEntry!,
      ...projectAgentCliAuthCatalogEntry({
        agentId: 'codex', pluginId: manifest.id, cli, runtimeSpec: agent.runtimeSpec,
        systemTools: manifest.contributes.systemTools, hostAccess: manifest.hostAccess,
        agentCliSystemTool: agent.catalogEntry?.agentCliSystemTool, isCurrent: () => true,
        // The plugin boundary consumes bounded command output; real host tool resolution and execution remain intact.
        cliAuth: { detectAuthStatus: async ({ runDeclaredSystemToolCommand }) => {
          const status = await runDeclaredSystemToolCommand({ toolId: 'codex-cli', args: ['login', 'status'], timeoutMs: 6_000 });
          return status.ok ? { state: 'logged_in', method: 'oauth_cli', source: 'command' }
            : status.exitCode === null ? { state: 'unknown', reason: 'probe_failed' }
              : { state: 'logged_out', reason: 'missing_credentials' };
        } },
      }),
    } };
  });
  const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
    contributes: createResolvedContributionRegistry({ agents, activationTargets: [] }), pluginIds: [],
  } });
  onTestFinished(async () => await fixture.dispose());
  return fixture.registry;
}

describe('daemon Agent preconditions', () => {
  it('admits a validated custom Session factory without an undeclared CLI prerequisite', async () => {
    const fixtureRoot = new URL('../../../../../packages/tests/fixtures/plugin-platform/agent-runtime-conformance/', import.meta.url);
    const sourceManifest = PluginManifestV2Schema.parse(JSON.parse(await readFile(new URL('.happier-plugin/plugin.json', fixtureRoot), 'utf8')));
    const nativeManifest = { ...sourceManifest, contributes: { ...sourceManifest.contributes,
      agents: sourceManifest.contributes.agents.map(({ cli: _cli, ...agent }) => agent) } };
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
      plugins: [{ manifest: nativeManifest,
        files: { 'daemon.mjs': await readFile(new URL('daemon.mjs', fixtureRoot), 'utf8'),
          'agent-runtime.mjs': await readFile(new URL('agent-runtime.mjs', fixtureRoot), 'utf8') } }],
      runtimeOptions: { pluginIds: ['acme.native-runtime-proof'] },
    });
    try {
      await fixture.registry.activateContributionsOnDemand([
        { pluginId: 'acme.native-runtime-proof', family: 'agents', localId: 'novel-native-agent' },
      ]);
      const agentId = 'acme.native-runtime-proof/novel-native-agent';
      expect(fixture.registry.agentRuntimesByAgentId.get(agentId)?.sessionRunnerFactoryBinding).toBeDefined();
      const spawnInput = {
        happyHomeDir: fixture.happyHomeDir, pluginRuntimeRegistry: fixture.registry, resolvedAgentId: agentId,
        options: { directory: fixture.happyHomeDir,
          backendTarget: { kind: 'backend', backendId: agentId, sourceKind: 'built_in' },
          agentTarget: { kind: 'agent', identity: { pluginId: 'acme.native-runtime-proof', localId: 'novel-native-agent' } } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: { PATH: '', HAPPIER_HOME_DIR: fixture.happyHomeDir },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      } satisfies Parameters<typeof resolveSpawnChildEnvironment>[0];
      const result = await resolveSpawnChildEnvironment(spawnInput);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(result).not.toHaveProperty('agentCliLaunchSpec');
      fixture.registry.retireConsumers();
      expect(await resolveSpawnChildEnvironment(spawnInput)).toMatchObject({ ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING, agentId });
    } finally { await fixture.dispose(); }
  });

  it('uses the activated native auth probe for an OAuth-only connected home and still rejects a missing credential', async () => {
    const home = await createTempDir('happier-spawn-activated-auth-', tmpdir());
    const fixture = await createAdmittedPluginRuntimeFixture({
      // The fixture's scoped pluginIds are activation authority, not just
      // eager-load preferences. Admit Codex before asking for its native probe.
      runtimeOptions: { pluginIds: ['happier.agent.codex'] },
    });
    try {
      const connectedHome = join(home, 'connected');
      await mkdir(connectedHome);
      await writeFile(join(connectedHome, 'auth.json'), JSON.stringify({
        auth_mode: 'chatgptAuthTokens', tokens: { access_token: 'fixture-access' },
      }));
      const probe = join(home, 'native-probe.cjs');
      // The native executable is an OS boundary: only this synthetic CLI is replaced.
      // Keep the real manifest, activation, catalog, environment and result parser.
      await writeFile(probe, `const fs = require('node:fs'); const path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
try { const auth = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8'));
process.exit(auth.tokens.access_token === 'fixture-access' ? 0 : 1); } catch { process.exit(1); }
`);
      const runtime = `'${process.execPath.replace(/'/g, `'\\''`)}'`;
      const script = `'${probe.replace(/'/g, `'\\''`)}'`;
      const cli = writeExecutableShimSync({
        dir: home, fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`
          : `#!/bin/sh\nexec ${runtime} ${script} "$@"\n`,
      });
      const params = {
        happyHomeDir: fixture.happyHomeDir,
        pluginRuntimeRegistry: fixture.registry,
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: join(home, 'signed-out'),
          HAPPIER_HOME_DIR: fixture.happyHomeDir, HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        connectedServiceAuth: { env: { CODEX_HOME: connectedHome }, cleanupOnFailure: null, cleanupOnExit: null,
          connectedServicesBindings: { v: 2, bindingsByServiceId: {} }, qualifiedPurposeBindingSnapshot: null },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      } satisfies Parameters<typeof resolveSpawnChildEnvironment>[0] & {
        connectedServiceAuth: NonNullable<Parameters<typeof prepareDaemonSpawnChildEnvironment>[0]['connectedServiceAuth']>;
      };
      await mkdir(join(home, 'custodian-home'));
      await writeFile(join(home, 'custodian-home', 'auth.json'), JSON.stringify({
        tokens: { access_token: 'fixture-access' },
      }));
      await expect(resolveSpawnChildEnvironment({ ...params, allowNativeAccountCredentials: false,
        connectedServiceAuth: null, processEnv: { ...params.processEnv, CODEX_HOME: join(home, 'custodian-home') },
      })).resolves.toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });
      // Connected-account materialization acquires the Agent before spawn;
      // the startup catalog must not be mistaken for this activated entry.
      const entry = await fixture.registry.acquireAgentCatalogEntry?.('codex');
      const authSpec = await entry?.getCliAuthSpec?.();
      await expect(authSpec?.detectAuthStatus?.({ resolvedPath: cli, processEnv: {
        ...params.processEnv, ...params.connectedServiceAuth?.env,
      } })).resolves.toMatchObject({ state: 'logged_in' });
      const admitted = await resolveSpawnChildEnvironment(params);
      if (!admitted.ok) expect(admitted.errorCode).toBe('agent_signed_out');
      expect(admitted).toMatchObject({ ok: true, extraEnvForChild: { CODEX_HOME: connectedHome } });
      const requester = await resolveSpawnChildEnvironment({ ...params, allowNativeAccountCredentials: false,
        connectedServiceAuth: { ...params.connectedServiceAuth!, targetMaterializedRoot: connectedHome },
        processEnv: { ...params.processEnv, OPENAI_API_KEY: 'custodian-key' },
      });
      expect(requester).toMatchObject({ ok: true, extraEnvForChild: { CODEX_HOME: connectedHome } });
      if (requester.ok) expect(requester.unsetEnvKeys).toContain('OPENAI_API_KEY');
      const sessionId = 'session-requester-committed';
      const requesterCredentials = { token: 'fixture-requester-token', encryption: null } as const;
      let createdSession: ReturnType<typeof createPlainSessionFixture> | null = null;
      const network = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        if (String(url).includes('/v1/account/encryption/currentness')) return {
          status: 200, data: createAccountEncryptionCurrentnessFixture(),
        };
        if (String(url).includes(`/v2/sessions/${sessionId}`) && createdSession) return { status: 200,
          data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
            metadata: JSON.stringify(createdSession.metadata), dataEncryptionKey: null }) } };
        throw new Error(`Unexpected Home read: ${String(url)}`);
      });
      const launchResourceScope = createProviderLaunchResourceScope();
      const providerDiagnosticRedactionLease = createProviderRedactionLease({ values: [] });
      try {
        // Home creation/read transports are the boundary; the real committed
        // launch and child-environment owners carry the requester identity.
        const committed = await commitDaemonLaunchSession({
          api: { getOrCreateSession: async input => {
            const session = { ...createPlainSessionFixture({ id: sessionId, metadata: createTestMetadata(input.metadata) }),
              sessionCreationOutcome: { disposition: 'created' as const, organizationPlacement: { folderId: null, tagIds: [] } },
            };
            createdSession = session;
            return session;
          } },
          credentials: requesterCredentials, directory: home, options: params.options, accountSettings: {},
        });
        expect(committed.ok).toBe(true);
        if (!committed.ok) throw new Error('Fixture committed Session could not attach');
        const child = await prepareDaemonSpawnChildEnvironment({
          options: { ...committed.session.options, requesterSessionCredentialFile: join(home, 'requester.json') },
          pluginRuntimeRegistry: fixture.registry, effectiveModelSelection: undefined, terminal: undefined,
          profileEnvironmentVariables: {}, daemonSpawnHooks: null, processEnv: params.processEnv,
          connectedServiceAuth: params.connectedServiceAuth!, connectedServiceMaterializationIdentity: null,
          providerBindingAttempt: null, providerAgentTargetKey: null, launchResourceScope, providerDiagnosticRedactionLease,
        });
        expect(child).toMatchObject({ ok: true, extraEnvForChild: {
          HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: join(home, 'requester.json'),
          HAPPIER_SESSION_REQUESTER_SESSION_ID: sessionId, CODEX_HOME: connectedHome,
        } });
      } finally {
        network.mockRestore();
        await launchResourceScope.release();
        providerDiagnosticRedactionLease.close();
      }
      await expect(resolveSpawnChildEnvironment({ ...params, allowNativeAccountCredentials: false,
        connectedServiceAuth: { ...params.connectedServiceAuth!, targetMaterializedRoot: connectedHome },
        profileEnvironmentVariables: { OPENAI_API_KEY: '${CUSTODIAN_PRIVATE_KEY}' },
        processEnv: { ...params.processEnv, CUSTODIAN_PRIVATE_KEY: 'alice-private-key' },
      })).resolves.toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED });
      await rm(join(connectedHome, 'auth.json'));
      await expect(resolveSpawnChildEnvironment(params)).resolves.toMatchObject({
        ok: false, errorCode: 'agent_signed_out', agentId: 'codex',
      });
    } finally {
      await fixture.dispose();
      await removeTempDir(home);
    }
  });

  it('preserves the missing Agent identity through daemon child preparation', async () => {
    const home = await createTempDir('happier-spawn-prepared-preconditions-', tmpdir());
    const launchResourceScope = createProviderLaunchResourceScope();
    const providerDiagnosticRedactionLease = createProviderRedactionLease({ values: [] });
    try {
      const result = await prepareDaemonSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' } },
        effectiveModelSelection: undefined,
        terminal: undefined,
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home, HAPPIER_ANTIGRAVITY_PATH: join(home, 'missing-cli') },
        connectedServiceAuth: null,
        connectedServiceMaterializationIdentity: null,
        providerBindingAttempt: null,
        providerAgentTargetKey: null,
        providerDiagnosticRedactionLease,
        launchResourceScope,
      });
      expect(result).toMatchObject({ ok: false, result: { type: 'error', errorCode: 'agent_cli_missing', agentId: 'antigravity' } });
    } finally {
      await launchResourceScope.release();
      providerDiagnosticRedactionLease.close();
      await removeTempDir(home);
    }
  });

  it('requires the Agent CLI when dependency prerequisites succeed', async () => {
    const home = await createTempDir('happier-spawn-preconditions-', tmpdir());
    try {
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {},
        // An external plugin's prerequisite callback is the boundary; CLI resolution stays real.
        daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
        processEnv: { PATH: '', HAPPIER_HOME_DIR: join(home, 'happier') },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'agent_cli_missing', agentId: 'antigravity' });
      if (result.ok) throw new Error('expected missing Agent CLI');
      expect(result.errorMessage).toContain('Antigravity');
    } finally {
      await removeTempDir(home);
    }
  });

  it('does not invoke prerequisite acquisition when the Agent CLI is missing', async () => {
    const home = await createTempDir('happier-spawn-no-download-', tmpdir());
    let acquired = false;
    try {
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: { resolveRuntimePrerequisites: async () => { acquired = true; return { ok: true }; } },
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'agent_cli_missing', agentId: 'antigravity' });
      expect(acquired).toBe(false);
    } finally {
      await removeTempDir(home);
    }
  });

  it('uses an admitted Team broker route without native login, but never caller intent or another purpose', async () => {
    const home = await createTempDir('happier-spawn-team-auth-', tmpdir());
    try {
      const cli = writeExecutableShimSync({ dir: home,
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n' });
      const binding = { v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: 'resource-1',
        expectedResourceRevision: 3, deliveryMode: 'brokered' as const, teamId: 'team-1' };
      const params = { pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, existingSessionId: 'accepted-session', teamCredentialBindings: [binding],
          backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: home, HAPPIER_HOME_DIR: home,
          HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {} };
      expect(await resolveSpawnChildEnvironment(params)).toMatchObject({ ok: false, errorCode: 'agent_signed_out' });
      expect(await resolveSpawnChildEnvironment({ ...params, acceptedTeamCredentialBinding: binding })).toMatchObject({ ok: true });
      expect(await resolveSpawnChildEnvironment({ ...params, acceptedTeamCredentialBinding: { ...binding,
        slot: { kind: 'connected_service_purpose', purpose: { consumer: { pluginId: 'acme.other', localId: 'other' }, purpose: 'mcp' } },
      } })).toMatchObject({ ok: false, errorCode: 'agent_signed_out' });
    } finally { await removeTempDir(home); }
  });

  it('refuses a signed-out Agent and preserves cleanup for its prepared credentials', async () => {
    const home = await createTempDir('happier-spawn-signed-out-', tmpdir());
    try {
      const cli = writeExecutableShimSync({
        dir: home,
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32'
          ? '@echo off\r\nif "%1"=="--version" (echo 1.2.3 & exit /b 0)\r\nexit /b 1\r\n'
          : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi\nexit 1\n',
      });
      const cleanup = async () => {};
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: home, HAPPIER_HOME_DIR: home, HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        connectedServiceAuth: { env: {}, cleanupOnFailure: cleanup, cleanupOnExit: cleanup },
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'agent_signed_out', agentId: 'codex', cleanupOnFailure: cleanup });
    } finally {
      await removeTempDir(home);
    }
  });

  it.each(['profile', 'connected', 'provider'] as const)('admits credentials from the effective %s environment', async (source) => {
    const home = await createTempDir('happier-spawn-effective-auth-', tmpdir());
    try {
      const cli = writeExecutableShimSync({
        dir: home,
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n',
      });
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: source === 'profile' ? { CODEX_API_KEY: 'fixture-key' } : {},
        daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: home, HAPPIER_HOME_DIR: home, HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        ...(source === 'connected' ? { connectedServiceAuth: { env: { CODEX_API_KEY: 'fixture-key' }, cleanupOnFailure: null, cleanupOnExit: null } } : {}),
        ...(source === 'provider' ? { providerEnvironmentOverlay: [{ name: 'CODEX_API_KEY', value: 'fixture-key', source: 'provider' as const }] } : {}),
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errorMessage);
      expect(result.agentCliLaunchSpec?.resolvedPath).toBe(cli);
      expect(result.extraEnvForChild.CODEX_API_KEY).toBe('fixture-key');
    } finally {
      await removeTempDir(home);
    }
  });

  it('admits a materialized Provider binding without requiring unrelated native login', async () => {
    const home = await createTempDir('happier-spawn-provider-auth-', tmpdir());
    try {
      const cli = writeExecutableShimSync({
        dir: home, fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32'
          ? '@echo off\r\nif "%1"=="--version" (echo 1.2.3 & exit /b 0)\r\nexit /b 1\r\n'
          : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi\nexit 1\n',
      });
      const connectionId = ProviderConnectionIdSchema.parse('pc_fixture');
      const result = await resolveSpawnChildEnvironment({
        pluginRuntimeRegistry: await createPinnedSpawnAgentRegistry(),
        options: { directory: home, backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } },
        profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        processEnv: { PATH: '', HOME: home, USERPROFILE: home, CODEX_HOME: home, HAPPIER_HOME_DIR: home, HAPPIER_CODEX_PATH: cli, HAPPIER_JS_RUNTIME_PATH: process.execPath },
        providerBindingContext: { v: 1, agentTargetKey: 'codex', connectionId, modelId: 'fixture-model' },
        // The already-authorized Provider materializer is the external boundary.
        // Its real Codex adapter clears native keys and owns a separate transport key.
        materializeProviderBindingAfterHooks: async () => ({
          ok: true,
          providerEnvironmentOverlay: [
            { name: 'CODEX_API_KEY', value: null, source: 'provider' },
            { name: 'OPENAI_API_KEY', value: null, source: 'provider' },
            { name: 'HAPPIER_CODEX_PROVIDER_API_KEY', value: 'fixture-key', source: 'provider' },
          ],
          providerBindingLaunchHandoff: {
            v: 1, materialization: { v: 1, kind: 'spawnEnv' },
            sessionBindingMetadata: {
              v: 1, connectionId, contributionKey: 'plugin.openrouter/openrouter', connectionRevision: 1,
              protocol: 'openai-responses', materialization: 'spawnEnv', adapterBindingKey: 'fixture',
              compatibilityFingerprint: 'fixture-compatibility', bindingSecurityFingerprint: 'fixture-security',
              displaySnapshot: { providerName: 'Fixture', connectionName: 'Fixture', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
            },
          },
        }),
        logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
      });
      expect(result).toMatchObject({ ok: true, extraEnvForChild: { HAPPIER_CODEX_PROVIDER_API_KEY: 'fixture-key' } });
      if (!result.ok) throw new Error(result.errorMessage);
      expect(result.extraEnvForChild).not.toHaveProperty('CODEX_API_KEY');
      expect(result.unsetEnvKeys).toContain('CODEX_API_KEY');
    } finally {
      await removeTempDir(home);
    }
  });
});
