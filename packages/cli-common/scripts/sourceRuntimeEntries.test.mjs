import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { readCliSourceEntries, readWorkspacePackages, resolveWorkspaceSource, workspaceSourceCompilerPaths } from '../sourceRuntimeEntries.mjs';

describe('CLI source entry ownership', () => {
  it('selects the declared portable SDK source while preserving Node source ownership', async () => {
    const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const packages = await readWorkspacePackages(repoDir);
    const sdkRoot = join(repoDir, 'packages/plugin-sdk');
    expect(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk', {
      conditions: ['react-native', 'browser'],
    })).toBe(join(sdkRoot, 'src/index.browser.ts'));
    expect(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk/contributions', {
      conditions: ['react-native', 'browser'],
    })).toBe(join(sdkRoot, 'src/contributions/index.browser.ts'));
    expect(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk')).toBe(join(sdkRoot, 'src/index.ts'));
    expect(workspaceSourceCompilerPaths(packages)['@happier-dev/plugin-sdk']).toEqual([join(sdkRoot, 'src/index.ts')]);
    expect(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk/async', {
      conditions: ['react-native', 'browser'],
    })).toBe(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk/async'));
    expect(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk/voice/client', {
      conditions: ['react-native', 'browser'],
    })).toBe(join(sdkRoot, 'src/voice/client/index.ts'));
  });

  it('preserves conditional wildcard exports without accepting a built-dist portable branch', () => {
    const root = resolve('fixture-author-root');
    const packages = new Map([['fixture-author', { root, manifest: { exports: {
      './portable/*': {
        browser: { 'happier-source': './src/browser/*.ts', default: './dist/browser/*.js' },
        'happier-source': './src/node/*.ts', default: './dist/node/*.js',
      },
      './published-only': {
        browser: { default: './dist/browser/published.js' },
        'happier-source': './src/node/published.ts',
      },
    } } }]]);
    expect(resolveWorkspaceSource(packages, 'fixture-author/portable/migration', {
      conditions: ['browser'],
    })).toBe(join(root, 'src/browser/migration.ts'));
    expect(resolveWorkspaceSource(packages, 'fixture-author/portable/migration')).toBe(join(root, 'src/node/migration.ts'));
    expect(() => resolveWorkspaceSource(packages, 'fixture-author/published-only', {
      conditions: ['browser'],
    })).toThrow('Source runtime requires an explicit source export');
  });

  it('includes a bundled plugin native worker declared by its package imports', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'happier-plugin-native-entries-'));
    try {
      const cliDir = join(repoDir, 'apps/cli');
      const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
      const pluginDir = join(repoDir, 'packages/plugins/native-worker');
      await mkdir(locatorDir, { recursive: true });
      await mkdir(join(pluginDir, 'src/machine'), { recursive: true });
      await writeFile(join(pluginDir, 'src/index.ts'), 'export const activate = () => {};');
      await writeFile(join(pluginDir, 'src/machine/worker.ts'), 'export const value = 1;');
      await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-native-worker',
        exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } },
        imports: { '#native-worker': { 'happier-source': './src/machine/worker.ts', default: './dist/machine/worker.js' } },
      }));
      await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'),
        `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = ${JSON.stringify([{
          daemonEntryPath: './.happier-plugin/daemon.js',
          sourceSpec: { locator: '@happier-dev/plugins-native-worker' },
          manifest: { entrypoints: { daemon: './.happier-plugin/daemon.js' }, runtime: {} },
        }])};`);
      const { entries } = await readCliSourceEntries({ repoDir, manifest: {}, transform });
      expect(entries['packages/plugins/native-worker/dist/machine/worker']).toBe(join(pluginDir, 'src/machine/worker.ts'));
      expect(entries['packages/plugins/native-worker/.happier-plugin/daemon']).toBe(join(pluginDir, 'src/index.ts'));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
