import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildSourceRuntimeBundle, captureSourceWebBuildInputs, setBundleReadOnly } from './build_source_runtime.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { runServerRuntimeMigration } from '../runtime/launch/runServerRuntimeMigration.mjs';
import { resolveServerRuntimeLaunchSpec } from '../runtime/launch/resolveServerRuntimeLaunchSpec.mjs';

async function assertEmittedCodeClosure(t, outputDir, runtime) {
  const metafile = JSON.parse(await readFile(join(runtime.runtimeDir, 'metafile.json'), 'utf8'));
  const outputs = Object.entries(metafile.outputs);
  assert.ok(outputs.length > 0);
  for (const [path, output] of outputs) {
    // The producer's esbuild working directory is its now-retired captured view.
    const bytes = await readFile(resolve(outputDir, 'workspace', path));
    assert.equal(bytes.length, output.bytes, `retained output ${path}`);
  }
  await access(runtime.entrypoint);
  await assert.rejects(access(join(outputDir, 'workspace')), { code: 'ENOENT' });
  t.diagnostic(`Retained ${outputs.length} emitted code files after input capture retirement`);
}

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
  await assertEmittedCodeClosure(t, outputDir, runtime);
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

test('source server retains executable migration wrappers and the complete emitted code graph', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-migration-closure-', registerCleanup: false });
  t.after(async () => {
    await setBundleReadOnly(fixture.root, false);
    await fixture.cleanup();
  });
  const repoDir = fixture.path('repo');
  const serverDir = join(repoDir, 'apps/server');
  await Promise.all(['sources', 'scripts', 'node_modules'].map(path => mkdir(join(serverDir, path), { recursive: true })));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  // Shared and lazy code force closure beyond the two entry files. These are
  // producer input fixtures, not mocked compilation or migration consumers.
  await writeFile(join(serverDir, 'sources/shared.ts'), 'export const marker = "retained-code";');
  await writeFile(join(serverDir, 'sources/lazy.ts'), 'export const lazy = "retained-lazy";');
  const entry = `export { marker } from './shared'; export const load = () => import('./lazy');`;
  await writeFile(join(serverDir, 'sources/main.ts'), entry);
  await writeFile(join(serverDir, 'sources/main.light.ts'), entry);
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), `
    import { marker } from '../sources/shared';
    if (marker !== 'retained-code') throw new Error('missing shared migration code');
  `);
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'), `
    import { marker } from '../sources/shared';
    export async function runSqliteMigrationDeploy() {
      if (marker !== 'retained-code') throw new Error('missing shared migration code');
    }
  `);
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),
    join(serverDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const [dbProvider, serverComponent] of [['sqlite', 'happier-server-light'], ['postgres', 'happier-server']]) {
    const outputDir = fixture.path(dbProvider);
    const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir, component: 'server', serverComponent, dbProvider });
    await assertEmittedCodeClosure(t, outputDir, runtime);
    assert.equal(runtime.migration.command, join(outputDir, 'apps/server/scripts/migrate.mjs'));
    assert.equal(await readFile(runtime.migration.command, 'utf8'), "export * from './migrate.js';\n");
    const loaded = await import(pathToFileURL(runtime.entrypoint));
    assert.equal(loaded.marker, 'retained-code');
    assert.equal((await loaded.load()).lazy, 'retained-lazy');
    const serverLaunchSpec = resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch: runtime });
    await runServerRuntimeMigration({ serverLaunchSpec, env: process.env, children: [] });
    // Falsify the specific EH failure at the real consumer without changing
    // shared source or touching a retained user/Stack bundle.
    const wrapper = await readFile(runtime.migration.command);
    await rm(runtime.migration.command);
    await assert.rejects(runServerRuntimeMigration({ serverLaunchSpec, env: process.env, children: [] }), error =>
      error.code === 'ERUNTIMESERVERMIGRATIONUNAVAILABLE'
      && error.reason === 'unusable_artifact_migration_command' && error.cause?.code === 'ENOENT');
    await writeFile(runtime.migration.command, wrapper);
    t.diagnostic(`${dbProvider}: migrate.mjs runs; removing it reproduces the reported ENOENT`);
  }
});
