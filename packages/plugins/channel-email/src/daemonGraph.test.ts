import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The CLI owns the plugin bundler; this is a development graph check, not an
// Email runtime dependency or a host-specific loading path.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const { build } = createRequire(resolve(repoRoot, 'apps/cli/package.json'))('esbuild') as typeof import('esbuild');
const pluginRoot = fileURLToPath(new URL('./', import.meta.url));
const heavyPackages = ['cheerio', 'imapflow', 'nodemailer'] as const;

describe('Email daemon import boundary', () => {
  it('keeps mailbox libraries out of plugin activation until an email operation uses them', async () => {
    const { metafile } = await build({
      absWorkingDir: pluginRoot,
      entryPoints: ['index.ts'],
      outdir: 'unused-daemon-graph',
      platform: 'node',
      format: 'esm',
      bundle: true,
      write: false,
      metafile: true,
      conditions: ['happier-source'],
      // Public host contracts are the plugin's external boundary. Keep all of
      // Email's own code and mailbox dependencies real in this graph.
      external: ['@happier-dev/*'],
      logLevel: 'silent',
    });
    const inputs = metafile!.inputs;
    const eager = new Set<string>();
    function visit(path: string): void {
      if (eager.has(path)) return;
      eager.add(path);
      const input = inputs[path];
      if (!input) throw new Error(`Missing bundled input: ${path}`);
      for (const dependency of input.imports) {
        if (!dependency.external && dependency.kind !== 'dynamic-import') visit(dependency.path);
      }
    }
    visit('index.ts');
    const eagerlyLoaded: string[] = [];
    for (const name of heavyPackages) {
      const isPackageInput = (path: string) => path.replaceAll('\\', '/').includes(`/node_modules/${name}/`);
      // A missing/externalized dependency cannot make the cold assertion pass.
      expect(Object.keys(inputs).some(isPackageInput), `${name} remains available to first use`).toBe(true);
      if ([...eager].some(isPackageInput)) eagerlyLoaded.push(name);
    }
    expect(eagerlyLoaded, 'mailbox libraries must stay cold during activation').toEqual([]);
  });
});
