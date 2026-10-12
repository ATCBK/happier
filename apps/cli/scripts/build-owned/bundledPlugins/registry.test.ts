import { describe, expect, it } from 'vitest';
import { ModuleKind, transpileModule } from 'typescript';
import { renderCliBundledPluginManifestEntriesTs } from './registry';

describe('bundled manifest locator publication', () => {
  it('keeps declarations out of the imported locator module', () => {
    const output = renderCliBundledPluginManifestEntriesTs({ pluginPackages: [{
      pluginId: 'happier.fixture', pluginPackageId: 'fixture', packageName: '@happier-dev/plugins-fixture',
      packageVersion: '0.0.0', manifest: { schemaVersion: 2, id: 'happier.fixture', version: '0.0.0',
        runtime: { apiVersion: 1 }, contributes: { actions: [{ id: 'echo', inputSchema: { type: 'object' } }] } },
    }] });
    const exports: Record<string, unknown> = {};
    const emitted = transpileModule(output, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
    new Function('exports', emitted)(exports);
    const locators = exports.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS as readonly Record<string, unknown>[];
    expect(locators).toHaveLength(1);
    expect(locators[0]).not.toHaveProperty('manifest');
    expect(locators[0]).toMatchObject({ pluginId: 'happier.fixture',
      manifestRelativePath: 'assets/bundled-plugin-manifests/fixture.json' });
  });
});
