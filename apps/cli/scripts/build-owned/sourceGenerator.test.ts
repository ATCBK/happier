import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs, writeCliBundledHostPackage } from '../__tests__/testkit/packageLayoutSandbox';
import { renderCliBundledAgentRegistrationBindingsTs } from './bundledPlugins/registry';
import { PLUGIN_MANIFEST as CUSTOM_ACP_MANIFEST } from '../../../../packages/plugins/custom-acp/src/manifest';

describe('bundled generator preparation process boundary', () => {
  it('publishes and checks semantic projections from authored dependencies without internal dist', async () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happier-source-generator-');
    const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    // CLI source imports consume transfers and its peer-mediation dependency.
    // Keep that real source closure available to the no-dist loader boundary.
    const sourceWorkspaces = ['agents', 'protocol', 'cli-common', 'plugin-sdk', 'release-runtime', 'brand', 'transfers', 'peer-mediation'];
    const copy = (path: string) => {
      mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
      cpSync(join(sourceRoot, path), join(repoRoot, path), { recursive: true });
    };
    try {
      copy('scripts');
      copy('apps/stack/scripts');
      copy('apps/cli/scripts');
      copy('apps/cli/src');
      copy('apps/cli/tsconfig.json');
      copy('apps/cli/tsconfig.runtime.json');
      for (const name of sourceWorkspaces) {
        copy(`packages/${name}/package.json`);
        copy(`packages/${name}/src`);
      }
      copy('packages/brand/planet.mjs');
      // Development JS helpers are authored package files, not compiled output.
      cpSync(join(sourceRoot, 'packages/cli-common'), join(repoRoot, 'packages/cli-common'), {
        recursive: true, filter: (path) => !/(?:^|\/)(?:dist|node_modules)(?:\/|$)/u.test(path),
      });
      symlinkSync(join(sourceRoot, 'node_modules'), join(repoRoot, 'node_modules'), 'dir');
      const sourceOnlyLoader = join(repoRoot, 'source-only-loader.mjs');
      writeFileSync(sourceOnlyLoader, `
        import { registerHooks } from 'node:module';
        registerHooks({ resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context);
          if (/(?:packages|@happier-dev)\\/[^/]+\\/(?:dist|package-dist)\\//u.test(result.url)) {
            throw new Error('Generator consumed internal dist: ' + result.url);
          }
          return result;
        } });
      `);
      writeCliBundledHostPackage({ happyCliDir, bundledDependencies: ['@happier-dev/plugins-selected'] });
      writeFileSync(join(happyCliDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli', type: 'module', bundledDependencies: ['@happier-dev/plugins-selected'],
      }));
      const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'selected' });
      const manifest = {
        ...CUSTOM_ACP_MANIFEST,
        id: 'happier.selected', displayName: 'Selected',
      };
      // Full semantic publication inspects the authored public entry and its
      // declared Resources, not only the membership manifest/Agent facts.
      writeFileSync(join(packageRoot, 'src/index.ts'),
        [
          "import type { PluginApi } from '@happier-dev/plugin-sdk';",
          "import { createCustomAcpAgentRuntime } from './agent/runtime/factory.js';",
          "export { PLUGIN_MANIFEST as manifest } from './manifest.js';",
          'export function activate(api: PluginApi) {',
          "  api.agents.register('custom-acp', createCustomAcpAgentRuntime, {",
          "    sessionRunnerFactory: { module: './agent/runtime/factory', export: 'createCustomAcpAgentRuntime', runtimeApiVersion: 1 },",
          '  });',
          '}',
        ].join('\n'));
      mkdirSync(join(packageRoot, 'assets'), { recursive: true });
      cpSync(join(sourceRoot, 'packages/plugins/custom-acp/assets/brand.png'), join(packageRoot, 'assets/brand.png'));
      // Retained host registrations must agree with this synthetic host's real
      // Agent declaration; never retain the copied checkout's unrelated Agents.
      writeFileSync(join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
        renderCliBundledAgentRegistrationBindingsTs([{
          pluginId: manifest.id, localId: 'custom-acp', implementationOwnerId: 'custom-acp', registrationFamily: 'agents',
        }]));
      cpSync(join(sourceRoot, 'packages/plugins/custom-acp/src/agent'), join(packageRoot, 'src/agent'), { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-selected', version: '0.0.0', type: 'module' }));
      // Prior npm packaging can leave a nearer private workspace copy. It must
      // not become the authority for this authored-source generation.
      const privateProtocol = join(packageRoot, 'node_modules/@happier-dev/protocol');
      mkdirSync(privateProtocol, { recursive: true });
      writeFileSync(join(privateProtocol, 'package.json'), JSON.stringify({
        name: '@happier-dev/protocol', type: 'module', exports: {
          './plugins/manifest': { 'happier-source': './src/missing.ts', default: './dist/missing.js' },
        },
      }));
      writeFileSync(join(packageRoot, 'src/manifest.ts'), [
        "import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';",
        `const result = ingestPluginManifestV2(${JSON.stringify(manifest)});`,
        "if (!result.ok) throw new Error('Fixture authored manifest is invalid');",
        'export const PLUGIN_MANIFEST = result.manifest;',
      ].join('\n'));
      const unrelatedRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'unrelated' });
      writeFileSync(join(unrelatedRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-unrelated', version: '0.0.0', type: 'module' }));
      const { brand: _brand, resources: _resources, ...unrelatedManifest } = manifest;
      writeFileSync(join(unrelatedRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify({ ...unrelatedManifest, id: 'happier.unrelated', contributes: {} })};`);
      const generator = join(happyCliDir, 'scripts/build-owned/generateBundledPluginEntries.ts');
      const run = (mode: 'write' | 'check') => promisify(execFile)(process.execPath,
        ['--conditions=happier-source', '--import', sourceOnlyLoader, '--experimental-strip-types', generator, '--root', repoRoot,
          ...(mode === 'check' ? ['--scope', 'projections'] : []), '--workspace', 'plugins-selected', '--mode', mode],
        { cwd: repoRoot, env: { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '0',
          // Keep the no-dist assertion active in the real inspection children too.
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(sourceOnlyLoader).href)}`,
        }, encoding: 'utf8' });
      await run('write');
      expect(existsSync(join(packageRoot, '.happier-plugin'))).toBe(false);
      for (const name of sourceWorkspaces) {
        expect(existsSync(join(repoRoot, 'packages', name, 'dist'))).toBe(false);
      }
      const projection = join(happyCliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
      const published = readFileSync(projection, 'utf8');
      expect(published).toContain('happier.selected');
      await run('check');
      writeFileSync(projection, `${published}\nexport const drift = true;\n`);
      await expect(run('check')).rejects.toThrow(/differs/u);
      writeFileSync(projection, published);
      writeFileSync(join(packageRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify({ ...manifest, schemaVersion: 99 })};`);
      await expect(run('check')).rejects.toThrow(/Invalid PLUGIN_MANIFEST/u);
      expect(readFileSync(projection, 'utf8')).toBe(published);
    } finally { cleanup(); }
  }, 120_000);
});
