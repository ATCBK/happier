import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { readCurrentDaemonPluginCatalogSnapshot } from './currentCatalog';

it('retains immutable bundled declaration projections across fresh daemon catalog reads', async () => {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-fx8-catalog-'));
  const reloadController = createPluginReloadController({ happyHomeDir });
  try {
    const initial = await readCurrentDaemonPluginCatalogSnapshot({ reloadController, happyHomeDir });
    expect(initial.plugins.length).toBeGreaterThan(0);
    const reads = [];
    for (let index = 0; index < 5; index++) {
      reads.push(await readCurrentDaemonPluginCatalogSnapshot({ reloadController, happyHomeDir }));
    }
    for (const snapshot of reads) {
      expect(snapshot.tools).toEqual([]);
      expect(snapshot.plugins.map(entry => entry.pluginId)).toEqual(initial.plugins.map(entry => entry.pluginId));
      for (const [index, entry] of snapshot.plugins.entries()) {
        // Declaration introspection is immutable for this process's admitted
        // bundled manifests; runtime generations are joined separately.
        expect(entry.contributionIntrospection).toBe(initial.plugins[index]!.contributionIntrospection);
        expect(entry.desiredGeneration).toBeNull();
        expect(entry.appliedGeneration).toBeNull();
      }
    }
  } finally {
    await reloadController.shutdown();
    await rm(happyHomeDir, { recursive: true, force: true });
  }
}, 180_000);
