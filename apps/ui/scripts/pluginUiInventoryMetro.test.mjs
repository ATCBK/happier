import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(uiRoot, 'package.json'));

test('Metro indexes retained private inventory assets before and after its initial crawl', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'happier-plugin-ui-filemap-'));
  const inventoryRoot = join(fixture, 'inputs');
  const projectRoot = join(fixture, 'project');
  const inventory = join(inventoryRoot, 'inventory.js');
  const previousInventory = process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
  const previousStack = process.env.HAPPIER_STACK_STACK;
  let graph;
  try {
    process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = inventory;
    process.env.HAPPIER_STACK_STACK = 'fixture-plugin-ui-filemap';
    await mkdir(projectRoot);
    const first = join(inventoryRoot, 'preparation-first/channels/happier-plugin-ui/react-native/channel-state-migrations/entry.cjs.bundle');
    await mkdir(dirname(first), { recursive: true });
    await writeFile(first, 'module.exports = {};\n');
    await writeFile(inventory, `export const bytes = require(${JSON.stringify(first)});\n`);
    delete require.cache[require.resolve(join(uiRoot, 'metro.config.js'))];
    const config = require(join(uiRoot, 'metro.config.js'));
    // Keep the private root supplied by the real config. Withholding that
    // root must fail hashing/resolution, rather than being hidden by a crawl
    // of an enclosing fixture or unrelated workspace sources.
    config.projectRoot = projectRoot;
    config.watchFolders = config.watchFolders.filter(folder => folder === inventoryRoot);
    config.maxWorkers = 2;
    config.fileMapCacheDirectory = join(fixture, 'cache');
    await mkdir(config.fileMapCacheDirectory);
    config.reporter = { update() {} };
    const Graph = require('metro/private/node-haste/DependencyGraph').default;
    graph = new Graph(config, { watch: true });
    await graph.ready();
    const resolveAsset = (asset, platform) => graph.resolveDependency(inventory, {
      name: asset, data: { key: asset, asyncType: null, isESMImport: false, locs: [] },
    }, platform, { dev: true });
    for (const platform of ['web', 'android']) {
      assert.equal(resolveAsset(first, platform).filePath, first);
      assert.ok((await graph.getOrComputeSha1(first)).sha1);
    }
    const late = join(inventoryRoot, 'preparation-late/channels/happier-plugin-ui/react-native/channel-state-migrations/entry.cjs.bundle');
    let onChange;
    const indexed = new Promise((resolve, reject) => {
      if (t.signal.aborted) { reject(t.signal.reason); return; }
      const onAbort = () => {
        graph.off('change', onChange);
        reject(t.signal.reason);
      };
      onChange = () => {
        if (graph.doesFileExist(late)) {
          graph.off('change', onChange);
          t.signal.removeEventListener('abort', onAbort);
          resolve();
        }
      };
      t.signal.addEventListener('abort', onAbort, { once: true });
      graph.on('change', onChange);
    });
    await mkdir(dirname(late), { recursive: true });
    await writeFile(late, 'module.exports = { refreshed: true };\n');
    await writeFile(inventory, `export const bytes = require(${JSON.stringify(late)});\n`);
    await indexed;
    for (const platform of ['web', 'android']) {
      assert.equal(resolveAsset(late, platform).filePath, late);
      assert.ok((await graph.getOrComputeSha1(late)).sha1);
    }
  } finally {
    if (graph) await graph.end();
    if (previousInventory === undefined) delete process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
    else process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = previousInventory;
    if (previousStack === undefined) delete process.env.HAPPIER_STACK_STACK;
    else process.env.HAPPIER_STACK_STACK = previousStack;
    delete require.cache[require.resolve(join(uiRoot, 'metro.config.js'))];
    await rm(fixture, { recursive: true, force: true });
  }
});
