import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { createDaemonPluginDevelopmentRootsOwner } from './developmentRoots';

import { createPackedTestConnectedAccountsRuntime } from './packedTestConnectedAccounts';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

function createRuntime(happyHomeDir: string, pluginId: string) {
  const reloadController = createPluginReloadController({
    happyHomeDir,
    resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({
      contributes: createResolvedContributionRegistry({}),
    }),
  });
  const owner = createDaemonPluginRuntimeOwner({
    happyHomeDir,
    staleCandidateCleanup: 'disabled',
    reloadController,
    connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir, pluginId }).owner,
  });
  return { owner, reloadController, async dispose() {
    await owner.changeService.shutdown();
    await reloadController.shutdown();
  } };
}

it('re-enables a reviewed source in place, changes policy, and re-enables after process custody is restored', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-lifecycle-')));
  const entryPath = join(root, 'plugin.ts');
  const pluginId = 'acme.development-lifecycle';
  let runtime = createRuntime(root, pluginId);
  const store = createPluginRegistryStateStore({ happyHomeDir: root });
  const manifest = createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined,
    contributes: { actions: [{ id: 'identity', title: 'Identity', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
  });
  const source = (value: string) => [
    `export const manifest = ${JSON.stringify(manifest)};`,
    `export function activate(api) { api.actions.register('identity', () => ({ value: ${JSON.stringify(value)} })); }`,
  ].join('\n');
  const invoke = () => runtime.reloadController.getState().activeRegistry!.targetActionInvocations.invoke({
    pluginId, localId: 'identity', input: {}, surface: 'cli',
  });
  try {
    await writeFile(entryPath, source('first'));
    const lease = await runtime.reloadController.acquireRuntimeRegistry();
    await lease.release();
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const pending = (await runtime.owner.changeService.listPendingPluginChanges()).changes[0]!;
    await expect(runtime.owner.changeService.decidePluginChange({
      pendingChangeId: pending.pendingChangeId, decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });

    // Use the real durable/runtime lifecycle; the public disable Action also
    // requires a server-owned managed-resource census, outside this regression.
    const roots = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir: root,
      submitObservation: async () => ({ kind: 'retained' }),
    });
    await roots.initialize();
    const mutationStore = createPluginRegistryStateStore({ happyHomeDir: root,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({
        happyHomeDir: root, reloadController: runtime.reloadController,
        resolveDevelopmentSourceAuthority: roots.resolveDevelopmentSourceAuthority,
      }),
    });
    try {
      await mutationStore.setEnabledWithResult(pluginId, false);
      await expect(runtime.owner.changeService.requestPluginChange({ kind: 'enable', pluginId }))
        .resolves.toMatchObject({ kind: 'committed', pluginId });
      expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeTruthy();
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { value: 'first' } });
      await expect(runtime.owner.changeService.requestPluginChange({ kind: 'setUpdatePolicy', pluginId, policy: 'pinned' }))
        .resolves.toMatchObject({ kind: 'committed', pluginId });
      expect((await store.read()).plugins[pluginId]!.install.updatePolicy).toBe('pinned');
      expect((await runtime.owner.readCatalog()).find(plugin => plugin.pluginId === pluginId)?.install.updatePolicy)
        .toBe('pinned');
      await expect(runtime.owner.changeService.requestPluginChange({ kind: 'update', pluginId }))
        .resolves.toMatchObject({ kind: 'failed', code: 'plugin_update_pinned' });
      await mutationStore.setEnabledWithResult(pluginId, false);
      await expect(runtime.owner.changeService.requestPluginChange({ kind: 'setUpdatePolicy', pluginId, policy: 'allowed' }))
        .resolves.toMatchObject({ kind: 'committed', pluginId });
      expect((await store.read()).plugins[pluginId]!.install.updatePolicy).toBe('allowed');
      expect((await runtime.owner.readCatalog()).find(plugin => plugin.pluginId === pluginId)?.install.updatePolicy)
        .toBe('allowed');
    } finally {
      await roots.stop();
    }

    await runtime.dispose();
    runtime = createRuntime(root, pluginId);
    const restoredLease = await runtime.reloadController.acquireRuntimeRegistry();
    await restoredLease.release();
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    await expect(runtime.owner.changeService.requestPluginChange({ kind: 'enable', pluginId }))
      .resolves.toMatchObject({ kind: 'committed', pluginId });
    expect((await store.read()).plugins[pluginId]!.state.enabled).toBe(true);
    expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeTruthy();
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { value: 'first' } });
    await expect(runtime.owner.changeService.requestPluginChange({ kind: 'update', pluginId }))
      .resolves.toMatchObject({ kind: 'failed', code: 'plugin_development_update_requires_reload' });
    await writeFile(entryPath, source('updated'));
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: entryPath });
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { value: 'updated' } });
    const restoredRoots = createDaemonPluginDevelopmentRootsOwner({ happyHomeDir: root,
      submitObservation: async () => ({ kind: 'retained' }),
    });
    await restoredRoots.initialize();
    try {
      await createPluginRegistryStateStore({ happyHomeDir: root,
        runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir: root,
          reloadController: runtime.reloadController,
          resolveDevelopmentSourceAuthority: restoredRoots.resolveDevelopmentSourceAuthority,
        }),
      }).setEnabledWithResult(pluginId, false);
      await expect(runtime.owner.changeService.requestPluginChange({ kind: 'enable', pluginId }))
        .resolves.toMatchObject({ kind: 'committed', pluginId });
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { value: 'updated' } });
    } finally {
      await restoredRoots.stop();
    }
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])('publishes new dynamic Resources with their Actions, retaining v1 if v2 throws (%s)', async (crash) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-resource-update-')));
  const pluginId = 'acme.development-resource-update';
  const entryPath = join(root, 'plugin.ts');
  const runtime = createRuntime(root, pluginId);
  const writeVersion = async (revision: number, throws = false) => {
    const actions = ['identity', ...(revision > 1 ? ['added'] : [])].map(id => ({
      id, title: id, scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe',
    }));
    const manifest = createPluginManifestV2Fixture({
      id: pluginId, version: `${revision}.0.0`,
      entrypoints: { daemon: './plugin.mjs', development: './plugin.ts' },
      contributes: {
        actions,
        resources: [{ id: 'baseline', source: 'dynamic', kind: 'config', contentType: 'application/json' }, ...(revision > 1 ? [{
          id: 'status', source: 'dynamic', kind: 'config', contentType: 'application/json',
        }] : [])],
      },
    });
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate(api) {',
      `api.actions.register('identity', async () => ({ revision: ${revision} }));`,
      `api.resources.registerDynamicResource('baseline', { read: async () => JSON.stringify({ revision: ${revision} }), observe: () => ({ dispose() {} }) });`,
      ...(revision > 1 ? [
        `api.actions.register('added', async () => ({ revision: ${revision} }));`,
        `api.resources.registerDynamicResource('status', { read: async () => JSON.stringify({ revision: ${revision} }), observe: () => ({ dispose() {} }) });`,
      ] : []),
      ...(throws ? ["throw new Error('candidate activation failed');"] : []),
      '}',
    ].join('\n'));
  };
  const active = () => runtime.reloadController.getState().activeRegistry!;
  const invoke = (localId = 'identity') => active().targetActionInvocations.invoke({
    pluginId, localId, input: {}, surface: 'cli',
  });
  const store = createPluginRegistryStateStore({ happyHomeDir: root });
  try {
    await writeVersion(1);
    const initial = await runtime.reloadController.acquireRuntimeRegistry();
    await initial.release();
    await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const pending = (await runtime.owner.changeService.listPendingPluginChanges()).changes[0]!;
    await expect(runtime.owner.changeService.decidePluginChange({
      pendingChangeId: pending.pendingChangeId, decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
    const incumbentOccurrence = runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId);
    expect(incumbentOccurrence).toBeTruthy();
    await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { revision: 1 } });

    await writeVersion(2, crash);
    const update = await runtime.owner.changeService.controlPluginDevelopment!({ kind: 'reload', rootPath: entryPath });
    if (crash) {
      expect(update.status.plugins).toEqual(expect.arrayContaining([expect.objectContaining({
        pluginId, phase: 'retained_incumbent', diagnostic: expect.objectContaining({
          code: 'plugin_change_failed', message: expect.stringContaining('candidate activation failed'),
        }),
      })]));
      expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBe(incumbentOccurrence);
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { revision: 1 } });
      expect(active().contributes.resources.map(resource => resource.definition.id)).toEqual(['baseline']);
      expect(active().contributes.actions.some(action => action.definition.id === 'added')).toBe(false);
      expect((await store.read()).plugins[pluginId]?.install.manifestVersion).toBe('1.0.0');
      const incumbentResource = await active().readUiResource!({
        expectedCallerOccurrenceId: incumbentOccurrence!, callerPluginId: pluginId, resourceId: 'baseline',
      });
      expect(JSON.parse(new TextDecoder().decode(incumbentResource.bytes))).toEqual({ revision: 1 });
    } else {
      expect(update.status.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ pluginId, phase: 'active' })]));
      await expect(invoke()).resolves.toMatchObject({ status: 'executed', value: { revision: 2 } });
      await expect(invoke('added')).resolves.toMatchObject({ status: 'executed', value: { revision: 2 } });
      const occurrenceId = runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId);
      expect(occurrenceId).toBeTruthy();
      expect(occurrenceId).not.toBe(incumbentOccurrence);
      const resource = await active().readUiResource!({
        expectedCallerOccurrenceId: occurrenceId!, callerPluginId: pluginId, resourceId: 'status',
      });
      expect(JSON.parse(new TextDecoder().decode(resource.bytes))).toEqual({ revision: 2 });
      expect((await store.read()).plugins[pluginId]?.install.manifestVersion).toBe('2.0.0');
      await expect(active().readUiResource!({
        expectedCallerOccurrenceId: incumbentOccurrence!, callerPluginId: pluginId, resourceId: 'status',
      })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    }
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not persist installation authority for an unregistered development candidate that cannot be adopted', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-unregistered-')));
  const pluginId = 'acme.unregistered-development';
  const entryPath = join(root, 'plugin.ts');
  const runtime = createRuntime(root, pluginId);
  try {
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined }))};`,
      'export function activate() {}',
    ].join('\n'));
    const lease = await runtime.reloadController.acquireRuntimeRegistry();
    await lease.release();
    const request = await runtime.owner.changeService.requestPluginChange({ kind: 'development', sourceRootPath: entryPath });
    expect(request.kind).toBe('reviewRequired');
    if (request.kind !== 'reviewRequired') throw new Error('Expected installation review');
    await expect(runtime.owner.changeService.decidePluginChange({
      pendingChangeId: request.pendingChangeId, decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'failed' });
    expect((await createPluginRegistryStateStore({ happyHomeDir: root }).read()).plugins[pluginId]).toBeUndefined();
    expect(runtime.reloadController.readCurrentPluginOccurrenceId?.(pluginId)).toBeNull();
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
