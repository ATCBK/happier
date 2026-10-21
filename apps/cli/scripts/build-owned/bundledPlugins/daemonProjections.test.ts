import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { projectPackedSessionRunnerModulePath } from '../../../src/plugins/authoring/bundleDaemonRuntime';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/custom-acp/src/manifest';
import { readCliSourceEntries } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage } from '../../__tests__/testkit/packageLayoutSandbox';
import { resolveGeneratorHostProjectionOutPaths } from './projectionPaths.mjs';
import { renderCliBundledPluginManifestAssets, renderCliBundledPluginManifestEntriesTs } from './registry';

it('checks every daemon-consumed runner locator against real registration without inspecting UI or catalog facts', async () => {
  const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-daemon-projections-');
  try {
    // Give the real generator its own publication root. Taking the checkout's
    // live publication lock would couple this fixture to unrelated builds.
    const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const scriptsDir = join(happyCliDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    cpSync(fileURLToPath(new URL('../', import.meta.url)), join(scriptsDir, 'build-owned'), {
      recursive: true, filter: path => !path.endsWith('.test.ts'),
    });
    cpSync(join(sourceRoot, 'apps/cli/scripts/pluginHostSharedRuntimePackages.mjs'), join(scriptsDir, 'pluginHostSharedRuntimePackages.mjs'));
    // Host projections are writable fixture outputs, so this tree must be a
    // private copy rather than a link to the shared checkout.
    cpSync(join(sourceRoot, 'apps/cli/src'), join(happyCliDir, 'src'), {
      recursive: true, filter: path => !/\.(?:test|spec|testkit)\.[^.]+$/u.test(path),
    });
    for (const path of ['scripts', 'node_modules', ...['agents', 'protocol', 'cli-common', 'plugin-sdk', 'release-runtime'].map(name => `packages/${name}`)]) {
      mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
      symlinkSync(join(sourceRoot, path), join(repoRoot, path), process.platform === 'win32' ? 'junction' : 'dir');
    }
    for (const path of ['tsconfig.json', 'tsconfig.runtime.json']) {
      cpSync(join(sourceRoot, 'apps/cli', path), join(happyCliDir, path));
    }
    const { main } = await import(pathToFileURL(join(scriptsDir, 'build-owned/generateBundledPluginEntries.ts')).href) as typeof import('../generateBundledPluginEntries');
    writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['@happier-dev/plugins-fixture'] });
    writeFileSync(join(happyCliDir, 'package.json'), JSON.stringify({
      ...JSON.parse(readFileSync(join(happyCliDir, 'package.json'), 'utf8')), type: 'module',
    }));
    const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'fixture' });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugins-fixture', version: '0.0.0', type: 'module',
      exports: { '.': { 'happier-source': './src/index.ts' } },
    }));
    const { brand: _brand, resources: _resources, ...manifest } = PLUGIN_MANIFEST;
    writeFileSync(join(packageRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
    const factorySource = join(packageRoot, 'src/agent/runtime/factory.ts');
    mkdirSync(dirname(factorySource), { recursive: true });
    writeFileSync(factorySource, 'export function createFixture() { throw new Error("fixture factory is not invoked at admission"); }');
    writeFileSync(join(packageRoot, 'src/index.ts'), [
      "export { PLUGIN_MANIFEST as manifest } from './manifest.js';",
      "import { createFixture } from './agent/runtime/factory.js';",
      'export function activate(api) {',
      "  api.agents.register('custom-acp', createFixture, {sessionRunnerFactory: {",
      "    module: './agent/runtime/factory', export: 'createFixture', runtimeApiVersion: 1,",
      '  }});',
      '}',
    ].join('\n'));
    for (const path of ['src/agent/definition.ts', 'src/ui/descriptor.ts']) {
      mkdirSync(dirname(join(packageRoot, path)), { recursive: true });
      writeFileSync(join(packageRoot, path), 'throw new Error("daemon must not inspect unrelated projection facts");');
    }
    const factory = {
      localAgentId: 'custom-acp',
      locator: { module: './agent/runtime/factory', export: 'createFixture', runtimeApiVersion: 1 as const },
      normalizedModulePath: projectPackedSessionRunnerModulePath({
        daemonEntrypoint: manifest.entrypoints!.daemon!, locatorModule: './agent/runtime/factory',
      }),
      loadMode: 'immutable-js' as const,
    };
    const normalized = ingestPluginManifestV2({ ...manifest, runtime: { ...manifest.runtime, agentFactories: [factory] } });
    if (!normalized.ok) throw new Error('Fixture declaration must pass the canonical manifest ingress');
    const projectedManifest = normalized.manifest;
    const pluginPackages = [{ pluginPackageId: 'fixture', pluginId: manifest.id,
      packageName: '@happier-dev/plugins-fixture', packageVersion: '0.0.0', manifest: projectedManifest }];
    const locator = resolveGeneratorHostProjectionOutPaths(repoRoot).cliManifestOutPath;
    mkdirSync(dirname(locator), { recursive: true });
    const locatorOutput = renderCliBundledPluginManifestEntriesTs({ pluginPackages });
    writeFileSync(locator, locatorOutput);
    const [asset] = renderCliBundledPluginManifestAssets({ pluginPackages });
    if (!asset) throw new Error('Fixture must produce its declaration asset');
    const assetPath = join(happyCliDir, asset.relativePath);
    mkdirSync(dirname(assetPath), { recursive: true });
    writeFileSync(assetPath, asset.out);
    const check = () => main(['--root', repoRoot, '--mode', 'check', '--daemon-projections']);
    await check();
    const { entries } = await readCliSourceEntries({ repoDir: repoRoot, manifest: {}, transform });
    expect(entries['packages/plugins/fixture/dist/index']).toBe(join(packageRoot, 'src/index.ts'));
    expect(entries['packages/plugins/fixture/dist/agent/runtime/factory']).toBe(factorySource);
    expect(entries[`packages/plugins/fixture/${factory.normalizedModulePath.replace(/\.js$/u, '')}`]).toBe(factorySource);
    // c86: the authored registration is current but its emitted declaration
    // still selects the old engine leaf. Admission must refuse before emission.
    const engineSource = join(packageRoot, 'src/agent/runtime/engine.ts');
    writeFileSync(engineSource, "export { createFixture } from './factory.js';");
    const staleManifest = { ...projectedManifest, runtime: {
      ...projectedManifest.runtime, agentFactories: [{ ...factory,
        locator: { ...factory.locator, module: './agent/runtime/engine' },
        normalizedModulePath: projectPackedSessionRunnerModulePath({
          daemonEntrypoint: manifest.entrypoints!.daemon!, locatorModule: './agent/runtime/engine',
        }),
      }],
    } };
    const [staleAsset] = renderCliBundledPluginManifestAssets({
      pluginPackages: [{ ...pluginPackages[0]!, manifest: staleManifest }],
    });
    if (!staleAsset) throw new Error('Fixture must produce its stale declaration asset');
    writeFileSync(assetPath, staleAsset.out);
    const stale = await readCliSourceEntries({ repoDir: repoRoot, manifest: {}, transform });
    expect(stale.entries['packages/plugins/fixture/dist/agent/runtime/engine']).toBe(engineSource);
    expect(stale.entries['packages/plugins/fixture/dist/agent/runtime/factory']).toBeUndefined();
    await expect(check()).rejects.toThrow(/generated output differs.*fixture\.json/u);
    expect(readFileSync(assetPath, 'utf8')).toContain('agent/runtime/engine');
    writeFileSync(assetPath, asset.out);
    writeFileSync(locator, `${locatorOutput}\nexport const drift = true;\n`);
    await expect(check()).rejects.toThrow(/generated output differs/u);
  } finally { cleanup(); }
}, 120_000);
