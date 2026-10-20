import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
const manifest: { exports: Record<string, { 'happier-source'?: string }> } = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
);

describe('shared client runtime boundaries', () => {
  it.each([
    'components/settings/server/localControl/useLocalRelayRuntimeControl.ts',
    'components/systemTasks/remoteSshBootstrap/nativeTask.ts',
    'components/personalHome/bootstrap/runPersonalHomeBootstrapFromSystemTasks.ts',
    'sync/domains/accessEndpoints/sources/relayAccessSource.ts',
  ])('%s does not bundle host filesystem, process or module-loader code', async (entry) => {
    const result = await build({
      absWorkingDir: repoRoot,
      entryPoints: [resolve(repoRoot, 'apps/ui/sources', entry)],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'neutral',
      format: 'esm',
      packages: 'external',
      // Metro transforms re-exported modules even when the client uses only one export.
      treeShaking: false,
      logLevel: 'silent',
      plugins: [{
        name: 'cli-common-public-source-exports',
        setup(builder) {
          // This gate owns cli-common's client graph; Metro validates the full app.
          builder.onResolve({ filter: /^@\// }, ({ path }) => ({ path, external: true }));
          builder.onResolve({ filter: /^@happier-dev\/cli-common(?:\/|$)/ }, ({ path }) => {
            const subpath = path.slice('@happier-dev/cli-common'.length);
            const source = manifest.exports[`.${subpath}`]?.['happier-source'];
            if (!source) throw new Error(`Missing cli-common source export: ${path}`);
            return { path: resolve(packageRoot, source) };
          });
        },
      }],
    });
    const nodeImports = Object.values(result.metafile.inputs)
      .flatMap((input) => input.imports.map((dependency) => dependency.path))
      .filter((path) => path.startsWith('node:'));
    expect([...new Set(nodeImports)].sort()).toEqual([]);
  });
});
