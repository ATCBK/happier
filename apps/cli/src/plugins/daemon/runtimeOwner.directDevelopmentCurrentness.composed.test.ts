import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPackedTestConnectedAccountsRuntime } from './packedTestConnectedAccounts';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

it('binds a direct development review to the registered source observation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-development-direct-review-')));
  const entryPath = join(root, 'plugin.ts');
  const pluginId = 'acme.development-direct-review';
  const reloadController = createPluginReloadController({
    happyHomeDir: root,
    resolveRuntimeRegistry: async () => resolveExecutablePluginRuntimeRegistry({
      contributes: createResolvedContributionRegistry({}),
    }),
  });
  const owner = createDaemonPluginRuntimeOwner({
    happyHomeDir: root,
    staleCandidateCleanup: 'disabled',
    reloadController,
    connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir: root, pluginId }).owner,
  });
  try {
    await writeFile(entryPath, [
      `export const manifest = ${JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined }))};`,
      'export function activate() {}',
    ].join('\n'));
    const lease = await reloadController.acquireRuntimeRegistry();
    await lease.release();

    await owner.changeService.controlPluginDevelopment!({ kind: 'registerExplicit', rootPath: entryPath });
    const initial = (await owner.changeService.listPendingPluginChanges()).changes[0];
    if (!initial) throw new Error('Expected initial development review');
    await expect(owner.changeService.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });

    const direct = await owner.changeService.requestPluginChange(
      { kind: 'development', sourceRootPath: entryPath },
      { retainReview: true },
    );
    expect(direct.kind).toBe('reviewRequired');
    if (direct.kind !== 'reviewRequired') throw new Error('Expected direct development review');
    await expect(owner.changeService.decidePluginChange({
      pendingChangeId: direct.pendingChangeId,
      decision: 'installAndTrust',
    })).resolves.toMatchObject({ kind: 'committed', pluginId });
  } finally {
    await owner.changeService.shutdown();
    await reloadController.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
