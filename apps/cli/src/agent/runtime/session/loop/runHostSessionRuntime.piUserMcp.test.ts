import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { accountSettingsParse, type McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { ApiClient } from '@/api/api';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runHostSessionRuntime, type HostSessionRuntimeFactoryParams } from './runHostSessionRuntime';

afterEach(() => {
  resetActiveAccountSettingsSnapshotForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('passes materialized selected user MCP servers to a native_extension Agent open request', async () => {
  const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
  const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
  const { loadBundledPluginLocators } = await import('@/plugins/projection/registry/builtIn/locators');
  const { projectBuiltInAgents } = await import('@/plugins/projection/registry/builtIn/agents');
  const { projectLoadedPluginContributes } = await import('@/plugins/projection/registry/resolvePluginContributions');
  const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
  const { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } = await import('@/plugins/projection/registry/sources/generatedBundledPluginManifests');
  const { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } = await import('@/plugins/projection/registry/sources/generatedBundledPlugins');
  // Load the real current Pi declaration through the normal manifest loader.
  // This scoped runtime does not depend on unrelated bundled projections.
  const piLocator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(locator => locator.pluginId === 'happier.agent.pi');
  if (!piLocator) throw new Error('Pi bundled locator unavailable');
  const sourceDeclarations = await Promise.all([
    ['pi', 'happier.agent.pi'], ['claude', 'happier.agent.claude'],
    ['codex', 'happier.agent.codex'], ['openai', 'happier.voice.openai'],
  ].map(async ([packageId, pluginId]) => {
    const sourcePath: string = `../../../../../../../packages/plugins/${packageId}/src/manifest`;
    const source: unknown = await import(sourcePath);
    if (!source || typeof source !== 'object' || !('PLUGIN_MANIFEST' in source)) throw new Error(`${packageId} source manifest unavailable`);
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(candidate => candidate.pluginId === pluginId);
    if (!locator) throw new Error(`${packageId} bundled locator unavailable`);
    return { ...locator, manifest: source.PLUGIN_MANIFEST };
  }));
  // Pi's real Connected Account references must resolve, even though this test
  // opens no credential or native process. Keep those real peer declarations.
  const loadedPlugins = loadBundledPluginLocators(sourceDeclarations);
  const projected = projectLoadedPluginContributes({
    loadResult: { loadedPlugins, diagnosticsByPluginId: {} },
    provenance: 'first_party',
  });
  const contributes = createResolvedContributionRegistry({ ...projected,
    agents: projectBuiltInAgents({ manifestAgents: projected.agents ?? [],
      registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS.filter(binding => binding.identity.pluginId === piLocator.pluginId) }),
  });
  const runtimeFixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { contributes, pluginIds: [] } });
  try {
  const credentials = { token: 'pi-user-mcp', encryption: null };
  const settings = accountSettingsParse({ mcpServersStrictMode: true });
  const servers: McpServerCatalogEntryV1[] = ['selected', 'excluded'].map(id => ({
    id, name: id, transport: 'stdio', stdio: { command: 'echo', args: [id] },
    env: { USER_VALUE: { t: 'literal', v: 'materialized-value' } }, createdAt: 1, updatedAt: 1,
  }));
  const snapshot: ActiveAccountSettingsSnapshot = {
    source: 'network', settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
    settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
    mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [],
      catalog: { v: 1, servers, bindings: servers.map(server => ({
        id: `binding-${server.id}`, serverId: server.id, enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
      })) } },
  };
  setActiveAccountSettingsSnapshot(snapshot);
  const metadata = createTestMetadata({ path: '/tmp/pi-project', permissionMode: 'default',
    mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['excluded'] } });
  // The Session transport is the boundary fixture. The host, real Agent catalog,
  // MCP selection, SavedSecret materializer, permission and queue owners stay real.
  const session = createMutableApiSessionClientFixture({ sessionId: 'pi-session', metadata,
    overrides: {
      claimCurrentSessionPublisherAuthorityForStartup: async () => ({ status: 'claimed' }),
      refreshSessionSnapshotFromServerRequired: async () => undefined,
      activateDurableMutationDelivery: async () => undefined,
      deactivateDurableMutationDelivery: () => undefined,
      enqueueSessionTurnMutation: async () => undefined,
      enqueueRegisteredSessionStateFieldMutation: async () => undefined,
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false }),
      onUserMessage: () => undefined,
      hasPendingProviderInput: () => false,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 }),
      subscribeExecutionRunActivitySnapshots: () => () => undefined,
      setOwnerActivityDelivery: () => undefined,
      setSessionRuntimeControls: () => undefined,
      hasOwnerMetadataAuthority: () => true,
      updateMetadataAsCurrentPublisher: async update => { session.updateMetadata(current => current ? update(current) : current); },
      readRolePromptOrganization: async () => ({}),
    },
  });
  const opened = new Error('Agent open boundary observed');
  let request: HostSessionRuntimeFactoryParams | undefined;
  let privateConfigPath: string | undefined;
  const api = await ApiClient.create(credentials);
  await expect(runHostSessionRuntime({ credentials, directory: metadata.path,
    accountSettingsContext: { ...snapshot, whenRefreshed: null } }, {
    flavor: 'pi', policyAgentId: 'pi', backendDisplayName: 'Pi', providerName: 'Pi',
    uiLogPrefix: '[Pi test]', waitingForCommandLabel: 'Pi', agentMessageType: 'pi',
    runtimeActivityApplicability: 'not_applicable',
    pluginRuntimeRegistryLease: runtimeFixture.lease,
    machineMetadata: { host: 'test', platform: process.platform, happyCliVersion: 'test',
      homeDir: '/tmp', happyHomeDir: '/tmp', happyLibDir: '/tmp' },
    loadTerminalDisplay: async () => () => null, shouldRenderTerminalDisplay: () => false,
    formatPromptErrorMessage: String,
    createSessionRuntime: params => {
      request = params;
      expect(params.mcpServersStrictMode).toBe(true);
      expect(Object.keys(params.mcpServers)).toEqual(['selected']);
      expect(JSON.stringify(params.mcpServers)).not.toContain('materialized-value');
      privateConfigPath = params.mcpServers.selected?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
      expect(privateConfigPath).toBeTruthy();
      const privateConfig = JSON.parse(readFileSync(privateConfigPath!, 'utf8'));
      expect(privateConfig).toMatchObject({ command: 'echo', args: ['selected'], env: { USER_VALUE: 'materialized-value' } });
      if (process.platform !== 'win32') expect(statSync(privateConfigPath!).mode & 0o777).toBe(0o600);
      throw opened;
    },
  }, {
    initializeBackendApiContextFn: async () => ({ api, machineId: 'pi-machine' }),
    initializeBackendRunSessionFn: async () => ({ session, reconnectionHandle: null,
      reportedSessionId: session.sessionId, attachedToExistingSession: false }),
  })).rejects.toBe(opened);
  expect(request?.mcpServers.selected?.env).toMatchObject({ HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: privateConfigPath });
  expect(existsSync(privateConfigPath!)).toBe(false);
  } finally {
    await runtimeFixture.dispose();
  }
});
