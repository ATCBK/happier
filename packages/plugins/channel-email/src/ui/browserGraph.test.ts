import { builtinModules, createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// CLI owns esbuild as the first-party plugin graph tool; Email has no runtime
// dependency on the bundler. Resolve that tool from its owning package root.
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const { build } = createRequire(resolve(repoRoot, 'apps/cli/package.json'))('esbuild') as typeof import('esbuild');
const uiRoot = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(uiRoot, '..');
const nodeBuiltins = new Set(builtinModules.map(name => name.replace(/^node:/u, '')));
const daemonPackages = new Set(['imapflow', 'nodemailer', 'mailparser']);

function browserGraph(entryPoints: string[], externalDaemonPeers = false) {
  const forbiddenImports: string[] = [];
  return build({
    entryPoints,
    absWorkingDir: pluginRoot,
    outdir: 'unused-browser-graph',
    bundle: true,
    write: false,
    platform: 'browser',
    conditions: ['happier-source'],
    // The negative control inspects Email's real daemon imports without asking
    // peer host SDKs to compile for a browser. UI graphs are fully bundled.
    ...(externalDaemonPeers ? { external: ['@happier-dev/*'] } : {}),
    metafile: true,
    logLevel: 'silent',
    plugins: [{
      name: 'email-ui-runtime-boundary',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path }) => {
          if (path.startsWith('node:') || nodeBuiltins.has(path)
            || [...daemonPackages].some(name => path === name || path.startsWith(`${name}/`))) {
            forbiddenImports.push(path);
            // Keep collecting every forbidden edge without loading Node packages.
            return { path, external: true };
          }
          return undefined;
        });
      },
    }],
  }).then(result => ({ result, forbiddenImports }));
}

describe('Email UI browser import boundary', () => {
  it('bundles every portable UI leaf without daemon modules or Node imports', async () => {
    const entries = readdirSync(uiRoot, { recursive: true })
      .filter((name): name is string => typeof name === 'string' && /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name))
      .map(name => resolve(uiRoot, name));
    expect(entries.length).toBeGreaterThan(0);
    const { result, forbiddenImports } = await browserGraph([...entries, resolve(pluginRoot, 'constants.ts')]);
    expect(forbiddenImports).toEqual([]);
    expect(Object.keys(result.metafile?.inputs ?? {})).not.toContain('plugin.ts');
    expect(Object.keys(result.metafile?.inputs ?? {})).not.toContain('channelActions.ts');
  });

  it('detects Node runtime dependencies through the actual daemon manifest graph', async () => {
    const { forbiddenImports } = await browserGraph([resolve(pluginRoot, 'manifest.ts')], true);
    expect(forbiddenImports).toEqual(expect.arrayContaining(['node:crypto', 'imapflow', 'nodemailer', 'mailparser']));
  });
});
