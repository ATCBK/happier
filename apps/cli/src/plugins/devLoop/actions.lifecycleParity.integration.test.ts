// Real MCP, Home-to-Machine HTTP and persisted daemon transactions belong to the source integration lane.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createDaemonPathPluginChangePreparer } from '@/plugins/daemon/pathChangePreparer';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginCliActionHost } from '@/plugins/testkit/pluginCliActionHost';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { executePluginDevLoopAction } from './actions';

const daemon = vi.hoisted(() => ({ request: vi.fn(), decide: vi.fn(), status: vi.fn() }));
// Substitute only daemon transport/startup. Requests enter the real daemon
// change service, preparer and registry transaction against temporary files.
vi.mock('@/daemon/controlClient', async original => ({ ...await original<typeof import('@/daemon/controlClient')>(), requestDaemonPluginChange: daemon.request, decideDaemonPluginChange: daemon.decide, readDaemonPluginChangeStatus: daemon.status }));
vi.mock('@/daemon/ensureDaemon', async original => ({ ...await original<typeof import('@/daemon/ensureDaemon')>(), ensureDaemonRunningForSessionCommand: async () => undefined }));
afterEach(() => { daemon.request.mockReset(); daemon.decide.mockReset(); daemon.status.mockReset(); resetActiveAccountSettingsSnapshotForTests(); });

it('uses the daemon uninstall owner equally with an implicit Machine target', async () => {
  daemon.request.mockResolvedValue({ kind: 'committed', pluginId: 'acme.lifecycle', desiredGeneration: null, appliedGeneration: null, pendingSurfaces: [] });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), pluginsDevLoopAction: args => executePluginDevLoopAction(args) });
  const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'plugins.uninstall': ['ui'] } });
  expect(await executor.execute('plugins.uninstall', { pluginId: 'acme.lifecycle' }, { surface: 'ui', authority: 'present_user', actionsSettings }))
    .toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
  expect(daemon.request.mock.calls[0]?.[0]).toEqual({ kind: 'uninstall', pluginId: 'acme.lifecycle' });
});

it('routes lifecycle effects to the exact semantic Machine and refuses conflicting selectors', async () => {
  const host = await createPluginCliActionHost();
  const input = { machineId: 'machine-2', pluginId: 'acme.lifecycle' };
  daemon.request.mockResolvedValue({ kind: 'committed', pluginId: input.pluginId, desiredGeneration: 'current', appliedGeneration: 'current', pendingSurfaces: [] });
  try {
    expect(await host.executePluginAction('plugins.enable', input)).toMatchObject({ ok: true, result: { ok: true } });
    expect(host.delivered).toHaveLength(1);
    expect(host.delivered[0]?.target).toMatchObject({ kind: 'machine', machineId: 'machine-2' });
    expect(await host.executePluginAction('plugins.enable', input, {}, 'machine-1')).toMatchObject({ ok: false });
    expect(daemon.request).toHaveBeenCalledTimes(1);
  } finally { await host.dispose(); }
});

it('routes installed-channel updates through Action approval and exact daemon custody', async () => {
  const host = await createPluginCliActionHost();
  const input = { machineId: 'machine-2', source: { kind: 'installed', pluginId: 'acme.lifecycle' } };
  try {
    daemon.request.mockResolvedValueOnce({ kind: 'failed', code: 'plugin_update_pinned', message: 'The installed channel is pinned.' });
    expect(await host.executeInstall(input)).toMatchObject({ ok: true, result: { ok: false, outcome: 'failed',
      change: { kind: 'failed', code: 'plugin_update_pinned' } } });
    expect(daemon.request.mock.calls[0]?.[0]).toEqual({ kind: 'update', pluginId: 'acme.lifecycle' });
    expect(daemon.decide).not.toHaveBeenCalled();
    const pending = { kind: 'reviewRequired' as const, reviewKind: 'installation' as const,
      pendingChangeId: 'installed-update-review', reason: 'authorityExpansion' as const, currentVersion: '1.0.0', authorityExpansion: ['requiredHostAccess' as const],
      review: createPluginInstallationReviewFixture({ pluginId: 'acme.lifecycle' }) };
    daemon.request.mockResolvedValueOnce(pending);
    daemon.status.mockResolvedValueOnce(pending);
    daemon.decide.mockResolvedValueOnce({ kind: 'committed', pluginId: 'acme.lifecycle', desiredGeneration: 'next', appliedGeneration: 'next', pendingSurfaces: [] });
    // The canonical fixture explicitly waives CLI install approval. The real
    // production composition still decides only the daemon-issued candidate.
    expect(await host.executeInstall(input)).toMatchObject({ ok: true, result: { ok: true, outcome: 'applied', change: { kind: 'committed' } } });
    expect(daemon.request.mock.calls[1]?.[0]).toEqual({ kind: 'update', pluginId: 'acme.lifecycle' });
    expect(daemon.decide.mock.calls[0]?.[0]).toEqual({ pendingChangeId: pending.pendingChangeId,
      decision: 'installAndTrust', optionalSelections: [] });
    expect(host.delivered.every(envelope => envelope.target?.kind === 'machine' && envelope.target.machineId === 'machine-2')).toBe(true);
    expect(await host.executeInstall(input, {}, 'machine-1')).toMatchObject({ ok: false });
    expect(daemon.request).toHaveBeenCalledTimes(2);
  } finally { await host.dispose(); }
});

it('discovers semantic lifecycle tools through MCP and changes actual daemon-owned installation state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-lifecycle-mcp-'));
  const happyHomeDir = join(directory, 'home');
  const pluginRoot = join(directory, 'plugin');
  const pluginId = 'acme.lifecycle';
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  const manifestPath = join(pluginRoot, '.happier-plugin/plugin.json');
  const manifest = createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const service = createDaemonPluginChangeService({ prepare: createDaemonPathPluginChangePreparer({ happyHomeDir,
    // Native contribution adoption is an OS/runtime boundary. The registry
    // still creates, swaps, retires and persists every actual transaction.
    runtimeLifecycle: { prepare: async candidate => ({ abort: async () => undefined,
      adopt: async () => Object.fromEntries(candidate.changedPluginIds.map(id => [id,
        candidate.installationState.plugins[id]?.enabled ? candidate.pluginOccurrenceIds[id]?.immutableGenerationId ?? null : null])) }) },
    readManagedResources: async () => ({ resources: [], reviewed: true }),
  }) });
  const store = createPluginRegistryStateStore({ happyHomeDir });
  async function install() {
    const result = await service.requestPluginChange({ kind: 'installPath', locator: pluginRoot });
    if (result.kind === 'reviewRequired') expect(await service.decidePluginChange({ pendingChangeId: result.pendingChangeId, decision: 'installAndTrust' })).toMatchObject({ kind: 'committed' });
    else expect(result).toMatchObject({ kind: 'committed' });
  }
  const server = new McpServer({ name: 'plugin-lifecycle', version: '1' });
  const client = new Client({ name: 'lifecycle-caller', version: '1' });
  try {
    await install();
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '1.1.0' }));
    await install();
    daemon.request.mockImplementation(request => service.requestPluginChange(request));
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), pluginsDevLoopAction: async ({ actionId, input, context }) => executePluginDevLoopAction({ actionId, input, context, happyHomeDir }) });
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: Object.fromEntries(
      ['plugins.enable', 'plugins.disable', 'plugins.rollback', 'plugins.trust.forget', 'plugins.update_policy.set'].map(id => [id, ['mcp']])) });
    const bridge = createActionToolExecutorBridge({ surface: 'mcp', executor, actionsSettings });
    const inventory = createHappierToolInventory({ surface: 'mcp', actionsSettings });
    registerHappierMcpBuiltInTools(server, { sessionId: 'lifecycle-session', surface: 'mcp',
      toolInventory: prepareHappierMcpToolInventory({ inventory, sessionId: 'lifecycle-session' }),
      deps: { ...bridge, changeTitle: async () => ({ success: true }),
        resolveActionOptions: args => bridge.resolveActionOptions(args, 'lifecycle-session') } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    const discovered = await client.listTools();
    async function invoke(actionId: string, extra: Readonly<Record<string, unknown>> = {}) {
      const name = actionId.replaceAll('.', '_');
      expect(discovered.tools.find(tool => tool.name === name), `Missing semantic lifecycle tool ${name}`).toBeDefined();
      const response = await client.callTool({ name, arguments: { pluginId, ...extra } });
      expect(response.isError, JSON.stringify(response)).toBe(false);
      return (await store.read()).plugins[pluginId]!;
    }
    expect((await invoke('plugins.disable')).state.enabled).toBe(false);
    expect((await invoke('plugins.enable')).state.enabled).toBe(true);
    expect((await invoke('plugins.update_policy.set', { policy: 'pinned' })).install.updatePolicy).toBe('pinned');
    expect((await invoke('plugins.rollback')).install.manifestVersion).toBe('1.0.0');
    expect((await invoke('plugins.trust.forget')).install.trust).toBeUndefined();
    const enableAfterTrustRemoval = await client.callTool({ name: 'plugins_enable', arguments: { pluginId } });
    // The Action policy waiver admits only the effect attempt, never package
    // trust. The real daemon must keep the forgotten installation disabled.
    expect(enableAfterTrustRemoval.structuredContent).toMatchObject({ ok: false });
    const forgotten = (await store.read()).plugins[pluginId]!;
    expect(forgotten.state.enabled).toBe(false);
    expect(forgotten.install.trust).toBeUndefined();
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).version).toBe('1.1.0');
  } finally { await client.close(); await server.close(); await service.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
