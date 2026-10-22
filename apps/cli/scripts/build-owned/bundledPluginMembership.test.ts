import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPackageLayoutSandbox, writeBundledPluginSourceInputs } from '../__tests__/testkit/packageLayoutSandbox';
import { readBundledPluginPackageNames } from './bundledPluginMembership';

it('retains a plugin with missing declarations in source capture while publication remains strict', () => {
  const { repoRoot, cleanup } = createPackageLayoutSandbox('happier-source-membership-');
  try {
    const root = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'broken' });
    rmSync(join(root, 'src/manifest.ts'));
    expect(() => readBundledPluginPackageNames(repoRoot)).toThrow(/Missing required plugin manifest/u);
    expect(readBundledPluginPackageNames(repoRoot, { requireManifestSource: false }))
      .toEqual(['@happier-dev/plugins-broken']);
  } finally { cleanup(); }
});
