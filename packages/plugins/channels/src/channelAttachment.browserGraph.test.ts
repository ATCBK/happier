import { dirname, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { resolveWorkspacePackageSource } from '../../../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const channelsProtocolSource = resolve(packageRoot, '../../channels-protocol/src/v1/index.ts');
const nodeBuiltins = new Set(builtinModules);

async function bundleBrowserEntry(entry: string): Promise<void> {
  await build({
    absWorkingDir: packageRoot,
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    logLevel: 'silent',
    plugins: [{
      name: 'channels-browser-boundaries',
      setup(bundler) {
        // Follow local and self-package static/dynamic imports. SDK/platform
        // packages are host boundaries; Channels' business schema stays real.
        bundler.onResolve({ filter: /^@happier-dev\/channels-protocol\/v1$/ }, () => ({ path: channelsProtocolSource }));
        bundler.onResolve({ filter: /^@happier-dev\/plugins-channels(?:\/|$)/ }, ({ path }) => {
          const source = resolveWorkspacePackageSource(path, '@happier-dev/plugins-channels', resolve(packageRoot, 'src'), {
            exportConditions: ['browser', 'happier-source'],
          });
          return source
            ? { path: source }
            : { errors: [{ text: `Channels browser graph cannot resolve its own export ${path}` }] };
        });
        bundler.onResolve({ filter: /^[^./]/ }, ({ path, kind, importer }) => {
          if (kind === 'entry-point') return undefined;
          if (path.startsWith('node:') || nodeBuiltins.has(path)) {
            return { errors: [{ text: `Browser source ${importer} imports Node-only ${path}` }] };
          }
          return { path, external: true };
        });
      },
    }],
  });
}

describe('Channels browser source boundaries', () => {
  it('bundles the attachment declaration and schema without Node runtime dependencies', async () => {
    await bundleBrowserEntry('src/channelAttachment.ts');
  });

  it('bundles the actual mounted surface including its dynamic dependency edges', async () => {
    await bundleBrowserEntry('src/ui/renderSurface.tsx');
  });

  it('does not hide the daemon manifest behind a self-package export', async () => {
    await expect(bundleBrowserEntry('@happier-dev/plugins-channels/manifest')).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('imports Node-only') }),
      ]),
    });
  });
});
