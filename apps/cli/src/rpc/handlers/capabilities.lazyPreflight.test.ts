import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, createActionExecutor, PluginManifestV2Schema, type RuntimeDescriptorV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

const home = await mkdtemp(join(tmpdir(), 'happier-preflight-lazy-'));
vi.stubEnv('HAPPIER_HOME_DIR', home);
vi.resetModules();

// Load the real host graph outside the per-operation timeout.
const { seedCurrentLocalPathPluginFixture } = await import('@/plugins/store/registry/currentState.testkit');
const { resolvePluginContributes } = await import('@/plugins/projection/registry/resolvePluginContributions');
const { createResolvedContributionRegistry, resolveMergedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
const { resolveExecutablePluginRuntimeRegistry } = await import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry');
const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
const { createCliCapabilitiesService, registerCapabilitiesHandlers } = await import('./capabilities');
const { resolveAgentProbeVariant } = await import('@/capabilities/probes/resolveAgentProbeVariant');
const inventoryProbes = await import('@/session/actions/cliActionDeps/resolveAgentProbeInventoryDeps');
const { createCliActionInventoryDeps } = await import('@/session/actions/cliActionDeps/createCliActionInventoryDeps');
const { createCliActionDeps } = await import('@/session/actions/createCliActionDeps');
const { resolveSessionCreationAgentTarget } = await import('@/session/creation/resolveSessionCreationAgentTarget');
const { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
const { createAgentProviderCatalogObservationService } = await import('@/providers/probe/agentCatalogObservation');
const { createProviderProbeScheduler } = await import('@/providers/probe/scheduler');
const { createProviderProbeHttpClient } = await import('@/providers/probe/client');
const { createProviderRedactionLease } = await import('@/providers/spawn/redaction');
const { createConnectedAccountPurposeBindingOwner } = await import('@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const fixtureKey = Symbol.for(home);
type FixtureBoundary = {
  disposed: number;
  modelId: string;
  modeId: string;
  thinking: boolean;
  onModels: (signal: AbortSignal, runtimeDescriptorV1?: RuntimeDescriptorV1, runtimeKindOverride?: string) => Promise<unknown>;
};
// The dynamically loaded external plugin is the boundary; all host registry,
// activation, projection, lease, cache and capability dispatch logic stays real.
const fixtureGlobals = globalThis as typeof globalThis & { [key: symbol]: FixtureBoundary | undefined };
const fixture: FixtureBoundary = {
  disposed: 0,
  modelId: 'discovered-model',
  modeId: 'plan',
  thinking: true,
  onModels: async () => [{ id: fixture.modelId, name: 'Discovered model' }],
};
fixtureGlobals[fixtureKey] = fixture;

describe('capability preflight with a cold Agent plugin', () => {
  afterAll(async () => {
    await pluginReloadController.shutdown();
    delete fixtureGlobals[fixtureKey];
    await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps selected-account Action model probes on the exact machine capability and refuses a foreign Agent observation', async () => {
    const connectedServices = { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'selected-account' },
    } } as const;
    const requests: unknown[] = [];
    let observedAgentId = 'opencode';
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
      rawSession: { metadata: {}, machineId: 'selected-machine', path: home },
      // The machine transport is the system boundary; its native producer uses the real observation schema.
      callMachineAction: async request => {
        requests.push(request);
        return { ok: true, result: AgentModelsProbeObservationSchema.parse({ agentId: observedAgentId,
          availableModels: [{ id: 'selected-account/model', name: 'Selected model' }], supportsFreeform: false, source: 'dynamic' }) };
      },
    });
    const args = { agentId: 'opencode', machineId: 'selected-machine', probe: { cwd: home, connectedServices } };
    expect(await inventory.agentsModelsList(args)).toMatchObject({ source: 'dynamic',
      items: [{ id: 'selected-account/model', label: 'Selected model' }] });
    expect(requests).toContainEqual(expect.objectContaining({ machineId: 'selected-machine', method: RPC_METHODS.CAPABILITIES_INVOKE,
      request: { id: 'cli.opencode', method: 'probeModels', params: expect.objectContaining({ cwd: home, connectedServices }) } }));
    observedAgentId = 'other-agent';
    expect(await inventory.agentsModelsList(args)).toMatchObject({ source: 'unavailable', items: [] });
  });

  it('lists configured native models through Action normalization and selected-machine transport, refusing mis-wired observations', async () => {
    const script = writeAcpTestAgentScript({ dir: home, fileName: 'configured-models.mjs', source: `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
          : request.method === 'session/new' ? { sessionId: 'configured-catalog', models: {
            currentModelId: 'remote-native', availableModels: [{ modelId: 'remote-native', name: 'Remote native' }],
          } } : null;
        if (result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      });
    ` });
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ source: 'network', settings, settingsVersion: 1,
      loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey({ token: 'fixture-token', encryption: null }),
      acpCatalog: { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
        id: 'remote-only', name: 'remote-only', title: 'Remote only',
        launch: { kind: 'command', command: process.execPath, args: [script] }, env: {}, createdAt: 1, updatedAt: 1,
      }] }) },
    });
    const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
      definitionId: 'remote-only' } as const;
    const nativeTarget = resolveSessionCreationAgentTarget(agentTarget);
    if (!nativeTarget) throw new Error('Configured Agent is not installed');
    expect((await createCliCapabilitiesService()).describe().capabilities)
      .toContainEqual(expect.objectContaining({ id: `cli.${nativeTarget.agentId}` }));
    const nativeObservation = AgentModelsProbeObservationSchema.parse(await inventoryProbes.probeAgentModelsBestEffort({
      agentId: nativeTarget.agentId, cwd: home, accountSettings: settings,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'remote-only' },
    }));
    expect(nativeObservation).toMatchObject({ agentId: nativeTarget.agentId, source: 'dynamic',
      availableModels: expect.arrayContaining([expect.objectContaining({ id: 'remote-native', name: 'Remote native' })]) });
    const expectedItems = nativeObservation.availableModels.map(model => ({ id: model.id, label: model.name }));
    const expectedOptions = expectedItems.map(model => ({ value: model.id, label: model.label }));
    const requests: unknown[] = [];
    let transport: 'native' | 'foreign-agent' | 'offline' = 'native';
    const deps = createCliActionDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
      rawSession: { metadata: {}, machineId: 'cli-machine', path: home },
      // The machine transport is the system boundary. Its response comes from
      // the real configured catalog/native ACP producer, through the strict consumer schema.
      machineActionDirectTargetTransport: { machineId: 'selected-machine', invoke: async (method, request) => {
        if (method !== RPC_METHODS.CAPABILITIES_INVOKE) return null;
        requests.push({ machineId: 'selected-machine', request });
        if (!request || typeof request !== 'object' || !('id' in request)
          || request.id !== `cli.${nativeTarget.agentId}`) throw new Error('Unregistered Agent capability');
        if (transport === 'offline') throw new Error('Selected Machine offline');
        return { ok: true, result: transport === 'foreign-agent'
          ? { ...nativeObservation, agentId: 'foreign-agent' } : nativeObservation };
      } },
    });
    const executor = createActionExecutor(deps);
    const input = { machineId: 'selected-machine',
      backendTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:remote-only', probe: { cwd: home } };
    const context = { surface: 'cli', authority: 'present_user' } as const;
    try {
      expect(await deps.agentsModelsList(input)).toMatchObject({ source: 'dynamic',
        items: expectedItems, probeObservation: { agentId: nativeTarget.agentId } });
      for (const selection of [{}, { agentId: 'acp:remote-only' }]) {
        const result = await executor.execute('agents.models.list', { ...input, ...selection }, context);
        expect(result).toMatchObject({ ok: true, result: { source: 'dynamic', items: expectedItems } });
        expect(result).not.toHaveProperty('result.agentId');
        expect(await executor.execute('action.options.resolve', { optionsSourceId: 'agents.models.available',
          draftInput: { ...input, ...selection } }, context)).toMatchObject({ ok: true, result: {
          options: expectedOptions,
        } });
      }
      const spawnInput = { actionId: 'session.spawn_new', fieldPath: 'modelSelection',
        executionTarget: { machineId: input.machineId }, directory: { kind: 'path', path: home },
        agentTarget };
      expect(await executor.execute('action.options.resolve', spawnInput, context)).toMatchObject({ ok: true,
        result: { options: expectedOptions } });
      expect(await executor.execute('action.options.resolve', { ...spawnInput, query: 'remote-native' }, context))
        .toMatchObject({ ok: true, result: { options: expectedOptions.filter(option => option.value === 'remote-native') } });
      const { handleActionsCommand } = await import('@/cli/commands/actions');
      let output = '';
      const previousExitCode = process.exitCode;
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
        output += String(chunk);
        const callback = args.find(argument => typeof argument === 'function');
        if (typeof callback === 'function') callback();
        return true;
      });
      try {
        await handleActionsCommand(['invoke', 'agents.models.list', '--input-json', JSON.stringify(input), '--json'], {
          readCredentialsFn: async () => ({ token: 'fixture-token', encryption: null }),
          createExecutorFn: () => ({ execute: executor.execute,
            resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
        });
        expect(JSON.parse(output)).toMatchObject({ ok: true, kind: 'actions_invoke',
          data: { source: 'dynamic', items: expectedItems } });
      } finally {
        stdout.mockRestore();
        process.exitCode = previousExitCode;
      }
      expect(requests).toContainEqual(expect.objectContaining({ machineId: 'selected-machine', request: {
        id: `cli.${nativeTarget.agentId}`, method: 'probeModels', params: {
          cwd: home, backendTarget: { kind: 'configuredAcpBackend', backendId: 'remote-only' },
        },
      } }));
      for (const failure of ['foreign-agent', 'offline'] as const) {
        transport = failure;
        expect(await executor.execute('agents.models.list', input, context)).toMatchObject({ ok: true, result: {
          source: 'unavailable', items: [], probeObservation: { agentId: nativeTarget.agentId, source: 'unavailable' },
        } });
        expect(await executor.execute('action.options.resolve', { optionsSourceId: 'agents.models.available',
          draftInput: input }, context)).toMatchObject({ ok: true, result: { options: [] } });
        expect(await executor.execute('action.options.resolve', spawnInput, context)).toMatchObject({ ok: true,
          result: { options: [] } });
      }
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('activates a cold Agent for probes and retains its occurrence through failures, cancellation and reload', async () => {
    const pluginRoot = join(home, 'fixture-plugin');
    await materializeSamplePluginFixture(pluginRoot);
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    const manifest = PluginManifestV2Schema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    // Use an existing executable only to satisfy CLI availability. No subprocess
    // is launched: the fixture contributes executable preflight callbacks.
    const agents = manifest.contributes?.agents?.map((agent) => ({
      ...agent,
      cli: agent.cli ? {
        ...agent.cli,
        executable: { ...agent.cli.executable, binaryName: basename(process.execPath) },
      } : undefined,
    }));
    await writeFile(manifestPath, JSON.stringify({
      ...manifest,
      activation: undefined,
      contributes: { ...manifest.contributes, agents },
    }));
    const daemonPath = join(pluginRoot, 'daemon.mjs');
    const daemonSource = await readFile(daemonPath, 'utf8');
    await writeFile(daemonPath, daemonSource
      .replace("export function activate(api) {", `export function activate(api) {
    const fixture = globalThis[Symbol.for(${JSON.stringify(home)})];`)
      .replace('sessionRunnerFactory: {', `preflightSessionControls: {
            probeModels: async ({ signal, runtimeDescriptorV1, runtimeKindOverride }) => await fixture.onModels(signal, runtimeDescriptorV1, runtimeKindOverride),
            probeModes: async ({ runtimeKindOverride }) => [{ id: runtimeKindOverride === 'appServer' ? 'legacy-mode' : fixture.modeId, name: 'Plan' }],
            probeConfigOptions: async ({ runtimeKindOverride }) => [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: runtimeKindOverride === 'appServer' ? false : fixture.thinking }],
        },
        sessionRunnerFactory: {`)
      .replace("api.hooks.register('resolve-prerequisites', resolveTranscriptBinding);", `api.hooks.register('resolve-prerequisites', resolveTranscriptBinding);
    return () => { fixture.disposed += 1; };`));

    await seedCurrentLocalPathPluginFixture({ happyHomeDir: home, pluginRoot, pluginId: SAMPLE_PLUGIN_ID, manifestVersion: manifest.version });
    const id = `cli.${SAMPLE_PLUGIN_ID}/sample-provider` as const;
    const standaloneService = await createCliCapabilitiesService();
    expect(await standaloneService.invoke({ id, method: 'probeModels', params: { cwd: join(home, 'standalone') } }))
      .toMatchObject({ ok: true, result: { source: 'unavailable' } });

    const resolveRuntime = async () => await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir: home,
      generation: pluginReloadController.getState().generation + 1,
      contributes: createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir: home })),
      currentGlobalExternalSessionsRouter: pluginReloadController.currentGlobalExternalSessions,
      targetedContributions: pluginReloadController.getTargetedContributionsOwner(),
    });
    const lease = await pluginReloadController.acquireRuntimeRegistry({ resolveRuntimeRegistry: resolveRuntime });
    try {
      expect(lease.registry.activatedPluginIds.has(SAMPLE_PLUGIN_ID)).toBe(false);
      const service = await createCliCapabilitiesService();
      const invokeModels = (cwd = home, signal?: AbortSignal) => service.invoke({
        id, method: 'probeModels', params: { cwd },
      }, { signal });
      const genericResult = await invokeModels();
      expect(genericResult).toMatchObject({
        ok: true,
        result: { source: 'dynamic', availableModels: expect.arrayContaining([{ id: 'discovered-model', name: 'Discovered model' }]) },
      });
      expect(genericResult).not.toHaveProperty('result.runtimeDescriptorV1Accepted');
      const runtimeDescriptorV1 = {
        v: 1 as const, agentId: `${SAMPLE_PLUGIN_ID}/sample-provider`, agent: { mode: 'exact-session' },
      };
      fixture.onModels = async (_signal, descriptor, runtimeKindOverride) => [{
        id: descriptor?.agent.mode === 'exact-session' ? 'exact-session-model'
          : runtimeKindOverride === 'appServer' ? 'legacy-model' : 'account-default-model',
        name: 'Context model',
      }];
      expect(await service.invoke({ id, method: 'probeModels', params: { cwd: home, runtimeDescriptorV1 } }))
        .toMatchObject({ ok: true, result: {
          runtimeDescriptorV1Accepted: true,
          availableModels: expect.arrayContaining([{ id: 'exact-session-model', name: 'Context model' }]),
        } });
      expect(await service.invoke({ id, method: 'probeModels', params: {
        cwd: home, runtimeDescriptorV1: { ...runtimeDescriptorV1, agentId: 'another-agent' },
      } })).toMatchObject({ ok: false });
      // cli-v0.2.12 (a357c655) sends this scalar. The Agent owns its meaning;
      // host cache identity must keep it distinct from the generic request above.
      expect(await service.invoke({ id, method: 'probeModels', params: { cwd: home, runtimeKindOverride: 'appServer' } }))
        .toMatchObject({ ok: true, result: { availableModels: expect.arrayContaining([{ id: 'legacy-model', name: 'Context model' }]) } });
      expect(await service.invoke({ id, method: 'probeModes', params: { cwd: home, runtimeKindOverride: 'appServer' } }))
        .toMatchObject({ ok: true, result: { availableModes: [{ id: 'legacy-mode', name: 'Plan' }] } });
      expect(await service.invoke({ id, method: 'probeConfigOptions', params: { cwd: home, runtimeKindOverride: 'appServer' } }))
        .toMatchObject({ ok: true, result: { configOptions: [{ id: 'thinking', currentValue: false }] } });
      expect(lease.registry.activatedPluginIds.has(SAMPLE_PLUGIN_ID)).toBe(true);
      expect(await service.invoke({ id, method: 'probeModes', params: { cwd: home } }))
        .toMatchObject({ ok: true, result: { source: 'dynamic', availableModes: [{ id: 'plan', name: 'Plan' }] } });
      expect(await service.invoke({ id, method: 'probeConfigOptions', params: { cwd: home } }))
        .toMatchObject({ ok: true, result: { source: 'dynamic', configOptions: [{ id: 'thinking', currentValue: true }] } });

      fixture.onModels = async () => { throw new Error('fixture provider unavailable'); };
      expect(await invokeModels(join(home, 'failure'))).toMatchObject({ ok: true, result: { source: 'unavailable' } });

      const cancellationStarted = deferred<void>();
      fixture.onModels = async (signal) => {
        cancellationStarted.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return [{ id: 'cancelled-model', name: 'Cancelled model' }];
      };
      const controller = new AbortController();
      const cancelled = invokeModels(join(home, 'cancelled'), controller.signal);
      await cancellationStarted.promise;
      controller.abort();
      expect(await cancelled).toMatchObject({ ok: false });

      const lateStarted = deferred<void>();
      const lateOutput = deferred<unknown>();
      fixture.onModels = async () => {
        lateStarted.resolve();
        return await lateOutput.promise;
      };
      const late = invokeModels(join(home, 'late'));
      await lateStarted.promise;
      // Only the capability operation now owns a lease on this occurrence.
      await lease.release();
      const nextRegistry = await resolveRuntime();
      expect(nextRegistry.readPluginOccurrenceId?.(SAMPLE_PLUGIN_ID))
        .not.toBe(lease.registry.readPluginOccurrenceId?.(SAMPLE_PLUGIN_ID));
      expect(await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: nextRegistry,
        changedPluginIds: [SAMPLE_PLUGIN_ID],
        runningSessionDisposition: 'retainRunningSessions',
      })).toMatchObject({ ok: true });
      expect(fixture.disposed).toBe(0);
      lateOutput.resolve([{ id: 'retired-model', name: 'Retired model' }]);
      expect(await late).toMatchObject({ ok: false });
      expect(fixture.disposed).toBe(1);

      fixture.modelId = 'reloaded-model';
      fixture.modeId = 'review';
      fixture.thinking = false;
      fixture.onModels = async () => [{ id: fixture.modelId, name: 'Discovered model' }];
      expect(nextRegistry.activatedPluginIds.has(SAMPLE_PLUGIN_ID)).toBe(false);
      const inventoryArgs = { agentId: `${SAMPLE_PLUGIN_ID}/sample-provider`, cwd: home };
      expect(await inventoryProbes.probeAgentModelsBestEffort(inventoryArgs)).toMatchObject({
        source: 'dynamic', availableModels: expect.arrayContaining([{ id: 'reloaded-model', name: 'Discovered model' }]),
      });
      const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
        rawSession: { path: home, machineId: 'fixture-machine', metadata: {} } });
      expect(await inventory.agentsModelsList({ agentId: inventoryArgs.agentId }))
        .toMatchObject({ source: 'dynamic', items: expect.arrayContaining([{ id: 'reloaded-model', label: 'Discovered model' }]) });
      expect(await inventoryProbes.probeAgentModesBestEffort(inventoryArgs))
        .toMatchObject({ source: 'dynamic', availableModes: [{ id: 'review' }] });
      expect(await inventoryProbes.probeAgentConfigOptionsBestEffort(inventoryArgs))
        .toMatchObject({ source: 'dynamic', configOptions: [{ id: 'thinking', currentValue: false }] });
      const nextService = await createCliCapabilitiesService();
      expect(await nextService.invoke({ id, method: 'probeModels', params: { cwd: home } })).toMatchObject({
        ok: true,
        result: { source: 'dynamic', availableModels: expect.arrayContaining([{ id: 'reloaded-model', name: 'Discovered model' }]) },
      });
      expect(await nextService.invoke({ id, method: 'probeModes', params: { cwd: home } }))
        .toMatchObject({ ok: true, result: { source: 'dynamic', availableModes: [{ id: 'review' }] } });
      expect(await nextService.invoke({ id, method: 'probeConfigOptions', params: { cwd: home } }))
        .toMatchObject({ ok: true, result: { source: 'dynamic', configOptions: [{ id: 'thinking', currentValue: false }] } });
    } finally {
      await lease.release();
    }
  }, 180_000);

  it('exposes a refused native refresh through RPC while retaining its last catalog observation', async () => {
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir: home,
      generation: pluginReloadController.getState().generation + 1,
      contributes: await resolveMergedContributionRegistry({ happyHomeDir: home }),
      pluginIds: ['happier.agent.claude'],
      // The registered development root is a filesystem authority boundary;
      // use the same fixture contract as the real bundled-registry integration suite.
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
        kind: 'development', registeredRootId: `preflight-fixture:${pluginId}`,
        canonicalRoot: rootPath, observedRevision: 1,
      }),
      currentGlobalExternalSessionsRouter: pluginReloadController.currentGlobalExternalSessions,
      targetedContributions: pluginReloadController.getTargetedContributionsOwner(),
    });
    expect(await pluginReloadController.adoptPreparedRuntimeRegistry({
      registry, changedPluginIds: [], runningSessionDisposition: 'retainRunningSessions',
    })).toMatchObject({ ok: true });
    const lease = await pluginReloadController.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => registry });
    try {
      const scheduler = createProviderProbeScheduler({ maxConcurrentOperations: 1, maxPendingOperations: 1 });
      let requests = 0;
      const outsideObservation = async (): Promise<never> => { throw new Error('Unexpected selected-account boundary'); };
      const bindingOwner = createConnectedAccountPurposeBindingOwner({
        store: { read: outsideObservation, update: outsideObservation, subscribe: () => ({ dispose() {} }) },
        selectTarget: outsideObservation,
        resolveTarget: outsideObservation,
        materializeAccount: outsideObservation,
        projectTargetAccounts: outsideObservation,
        assertTargetAccountMaterializable: outsideObservation,
      });
      const observation = createAgentProviderCatalogObservationService({
        // Explicit native bindings use the real lease owner without reading a
        // selected Account store, showing UI, or materializing Account secrets.
        activatePurposeBindings: input => bindingOwner.activatePurposeBindings(input),
        requestAuth: {
          lookupRequestAuth: async () => { throw new Error('Unexpected selected-account auth'); },
          refreshAfterAuthFailure: async () => { throw new Error('Unexpected selected-account refresh'); },
        },
        createRedactionLease: () => createProviderRedactionLease({ values: [] }),
        client: createProviderProbeHttpClient({
          resolveAddresses: async () => ['93.184.216.34'],
          transport: async () => {
            requests += 1;
            return { status: 200, headers: { 'content-type': 'application/json' },
              body: Buffer.from(JSON.stringify({ data: [{ id: 'claude-rpc-model', display_name: 'RPC model' }] })) };
          },
        }),
        scheduler,
        now: () => 42,
      });
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'machine-test', encryptionKey: new Uint8Array(32).fill(7), logger: () => undefined,
        registerHandlers: manager => registerCapabilitiesHandlers(manager, {
          getAgentCatalogObservation: () => ({ machineId: 'machine-test', service: observation }),
          // Native credential acquisition is an OS boundary; no real credential is read.
          resolveNativeCatalogBearer: async () => ({ accessToken: 'fixture-native-token', credentialFingerprint: `sha256:${'a'.repeat(64)}` }),
        }),
      });
      const invoke = () => client.call(RPC_METHODS.CAPABILITIES_INVOKE, {
        id: 'cli.claude', method: 'probeModels', params: { cwd: home, bypassCache: true },
      });
      const expectedModels = [{ id: 'default', name: 'Default' }, { id: 'claude-rpc-model', name: 'RPC model' }];
      expect(await invoke()).toMatchObject({ ok: true, result: { observedAt: 42, refreshError: false, availableModels: expectedModels } });
      const release = deferred<void>();
      const started = deferred<void>();
      const active = scheduler.runCatalog<{ status: 'success' | 'error' }>('occupied-rpc', 'manual_refresh', async () => {
        started.resolve(); await release.promise; return { status: 'success' as const };
      }, { unavailable: () => ({ status: 'error' }) });
      await started.promise;
      const queued = scheduler.runCatalog<{ status: 'success' | 'error' }>('queued-rpc', 'manual_refresh', async () => ({ status: 'success' as const }), { unavailable: () => ({ status: 'error' }) });
      try {
        expect(await invoke()).toMatchObject({ ok: true, result: {
          source: 'dynamic', observedAt: 42, refreshError: true, availableModels: expectedModels,
        } });
        expect(requests).toBe(1);
      } finally {
        release.resolve();
        await Promise.all([active, queued]);
      }
    } finally {
      await lease.release();
    }
  }, 180_000);

  it('does not reuse a probe variant across plugin occurrences', async () => {
    const input = { agentId: 'codex', catalogEntry: null, probeKind: 'models' as const };
    const previous = await resolveAgentProbeVariant({ ...input, runtimeCacheKey: 'occurrence-previous' });
    const current = await resolveAgentProbeVariant({ ...input, runtimeCacheKey: 'occurrence-current' });
    expect(current).not.toBe(previous);
  });
});
