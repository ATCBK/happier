import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildSourceRuntimeBundle, captureSourceWebBuildInputs, setBundleReadOnly } from './build_source_runtime.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';

test('source daemon serves every bundled packaged Resource through admitted activation roots', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-resource-composition-', registerCleanup: false });
  t.after(async () => {
    await setBundleReadOnly(fixture.root, false);
    await fixture.cleanup();
  });
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('repo');
  // Reuse the existing source fixture capture: real plugin declarations,
  // bytes, compiler and dependency closure, with no workspace dist publication.
  await captureSourceWebBuildInputs({ repoDir: canonicalRepo, outputDir: repoDir, component: 'daemon' });
  const cliDir = join(repoDir, 'apps/cli');
  const manifest = JSON.parse(await readFile(join(canonicalRepo, 'apps/cli/package.json'), 'utf8'));
  const plugins = manifest.bundledDependencies.filter(name => name.startsWith('@happier-dev/plugins-'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: manifest.name, type: 'module', exports: {}, imports: manifest.imports,
    dependencies: manifest.dependencies, bundledDependencies: plugins,
  }));
  await rm(join(cliDir, 'native'), { recursive: true, force: true });
  await writeFile(join(cliDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
  // A narrow real composition entry avoids unrelated daemon startup, author
  // SDK emission and native custody compilation. No internal owner is mocked.
  await writeFile(join(cliDir, 'src/index.ts'), `
    export { createBundledActivationSourceResolver } from './plugins/runtime/bundledActivationSource';
    export { createDaemonPluginDevelopmentRootsOwner } from './plugins/daemon/developmentRoots';
    export { createStableRetainedPluginResourcesOwner } from './plugins/runtime/invocation/services/resources';
    export { readCanonicalPluginManifest } from './plugins/manifest/normalize';
    export { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS, BUNDLED_FIRST_PARTY_PLUGIN_METADATA,
      BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from './plugins/projection/registry/sources/generatedBundledPluginManifests';
  `);
  const outputDir = fixture.path('runtime');
  const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir, component: 'daemon' });
  const probe = fixture.path('probe.mjs');
  await writeFile(probe, `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import * as host from ${JSON.stringify(pathToFileURL(runtime.entrypoint).href)};
    const repoDir = ${JSON.stringify(repoDir)};
    const runtimeRoot = ${JSON.stringify(outputDir)};
    const cliDir = ${JSON.stringify(runtime.runtimeDir)};
    const roots = host.createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir: ${JSON.stringify(fixture.path('home'))},
      submitObservation: async () => { throw new Error('Bundled admission must not start source observers'); },
    });
    const resolveSource = host.createBundledActivationSourceResolver({
      bundledPackageNames: host.BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES,
      resolveDevelopmentSourceAuthority: roots.resolveDevelopmentSourceAuthority,
    });
    const failures = [];
    let resourceCount = 0;
    let pluginCount = 0;
    try {
      for (const locator of host.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS) {
        const metadata = host.BUNDLED_FIRST_PARTY_PLUGIN_METADATA.find(item => item.pluginId === locator.pluginId);
        const raw = JSON.parse(await readFile(join(cliDir, locator.manifestRelativePath), 'utf8'));
        const manifest = host.readCanonicalPluginManifest(raw);
        assert.ok(manifest, 'The emitted producer manifest must pass its exact strict consumer');
        const declarations = manifest.contributes.resources.filter(resource => resource.path !== undefined);
        const rootPath = join(runtimeRoot, 'packages/plugins', metadata.pluginPackageId);
        // Executable plugins use the real activation resolver. Declaration-only
        // plugins use the same first-party membership admission as the registry.
        const authority = locator.daemonEntryPath
          ? resolveSource(locator)?.sourceAuthority
          : roots.resolveDevelopmentSourceAuthority({ pluginId: locator.pluginId, rootPath });
        pluginCount++;
        try {
          assert.equal(authority?.canonicalRoot, rootPath, locator.pluginId);
          if (!declarations.length) continue;
          const emitted = host.readCanonicalPluginManifest(JSON.parse(await readFile(join(rootPath, '.happier-plugin/plugin.json'), 'utf8')));
          assert.deepEqual(emitted?.contributes.resources, manifest.contributes.resources);
          const resources = await host.createStableRetainedPluginResourcesOwner({
            sourceIdentity: runtimeRoot, pluginId: locator.pluginId,
            rootPath: authority.canonicalRoot, declarations,
          });
          const service = resources.bind({ pluginId: locator.pluginId,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true });
          for (const declaration of declarations) {
            const expected = await readFile(join(repoDir, 'packages/plugins', metadata.pluginPackageId, declaration.path));
            const read = await service.read(declaration.id);
            assert.deepEqual(Buffer.from(read.bytes), expected, locator.pluginId + '/' + declaration.id);
            assert.equal(service.describe(declaration.id).size, expected.length);
            resourceCount++;
          }
        } catch (error) {
          failures.push({ pluginId: locator.pluginId, code: error.code ?? error.name, message: error.message });
        }
      }
    } finally { await roots.stop(); }
    assert.deepEqual(failures, [], JSON.stringify(failures));
    assert.ok(resourceCount > 0);
    console.log(JSON.stringify({ pluginCount, resourceCount }));
  `);
  const result = await promisify(execFile)(process.execPath, [probe], {
    env: { ...process.env, ...runtime.env }, cwd: fixture.root,
  });
  const counts = JSON.parse(result.stdout.trim());
  assert.equal(counts.pluginCount, plugins.length);
  assert.ok(counts.resourceCount > 0);
  t.diagnostic(`Composed ${counts.pluginCount} bundled plugins and ${counts.resourceCount} packaged Resources`);
});
