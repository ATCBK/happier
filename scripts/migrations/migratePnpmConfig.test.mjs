import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execPnpm } from '../workspaces/execPnpmCommand.mjs';
import ts from 'typescript';
import { parse } from 'yaml';

test('migration preserves the Pierre Shiki graph without changing the UI Shiki version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-pnpm-pierre-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/cli'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true,
    workspaces: ['apps/*'], dependencies: {}, devDependencies: {}, scripts: {} }));
  await writeFile(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
  const transform = fileURLToPath(new URL('./migratePnpmConfig.mjs', import.meta.url));
  execFileSync(process.execPath, [transform, root]);
  const configPath = join(root, 'pnpm-workspace.yaml');
  const first = await readFile(configPath, 'utf8');
  const config = parse(first);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies.shiki, '4.5.0', 'root supplies Pierre’s optional Shiki peer');
  assert.equal(config.overrides['@pierre/diffs>shiki'], '4.5.0');
  assert.equal(config.overrides['@pierre/diffs>@shikijs/transformers'], '4.5.0');
  assert.deepEqual(config.packageExtensions['@pierre/theming@1.0.1'].dependencies,
    { shiki: '4.5.0', '@shikijs/themes': '4.5.0' });
  assert.equal(config.overrides.shiki, undefined, 'UI keeps its directly declared 3.22.0');
  execFileSync(process.execPath, [transform, root]);
  assert.equal(await readFile(configPath, 'utf8'), first);
});

test('UI migration preserves its ambient Node contract and one portable Zod identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-pnpm-ui-types-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/cli'), { recursive: true });
  await mkdir(join(root, 'apps/ui'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true,
    workspaces: ['apps/*'], dependencies: {}, devDependencies: {}, scripts: {} }));
  await writeFile(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
  await writeFile(join(root, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/app', devDependencies: {} }));
  const configPath = join(root, 'apps/ui/tsconfig.json');
  await writeFile(configPath, '{\n// Preserve current host aliases.\n"compilerOptions": { "paths": { "@/*": ["./sources/*"] } }\n}\n');
  const transform = fileURLToPath(new URL('./migratePnpmConfig.mjs', import.meta.url));
  execFileSync(process.execPath, [transform, root]);
  const manifest = JSON.parse(await readFile(join(root, 'apps/ui/package.json'), 'utf8'));
  assert.equal(manifest.devDependencies['@types/node'], '25.0.10');
  const first = await readFile(configPath, 'utf8');
  const { config, error } = ts.parseConfigFileTextToJson(configPath, first);
  assert.equal(error, undefined);
  assert.deepEqual(config.compilerOptions.paths, {
    '@/*': ['./sources/*'], zod: ['../../node_modules/zod'], 'zod/*': ['../../node_modules/zod/*'],
  });
  assert.ok(first.includes('// Preserve current host aliases.'));
  execFileSync(process.execPath, [transform, root]);
  assert.equal(await readFile(configPath, 'utf8'), first);
});

test('migrated workspace scripts run without implicitly installing changed dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-pnpm-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const json = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  await mkdir(join(root, 'apps/cli'), { recursive: true });
  await json(join(root, 'apps/cli/package.json'), { name: '@happier-dev/cli', version: '0.2.10' });
  await json(join(root, 'package.json'), {
    name: 'pnpm-config-fixture', private: true, version: '1.0.0',
    workspaces: ['apps/*'], dependencies: {}, devDependencies: {},
    scripts: { postinstall: 'node postinstall.cjs', smoke: 'node smoke.cjs' },
  });
  await writeFile(join(root, 'postinstall.cjs'), "require('node:fs').writeFileSync('install-ran', 'yes'); process.exit(1);\n");
  await writeFile(join(root, 'smoke.cjs'), "require('node:fs').writeFileSync('script-ran', 'yes');\n");
  execFileSync(process.execPath, [fileURLToPath(new URL('./migratePnpmConfig.mjs', import.meta.url)), root]);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  // The fixture exercises generated manager policy using only local dependencies.
  delete manifest.devDependencies;
  await json(join(root, 'package.json'), manifest);
  const env = { ...process.env, CI: '1' };
  delete env.PNPM_SCRIPT_SRC_DIR;
  delete env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN;
  delete env.pnpm_config_verify_deps_before_run;
  execPnpm(['install', '--offline', '--ignore-scripts'], { cwd: root, env, preferPath: true });
  assert.equal(existsSync(join(root, 'install-ran')), false);
  await mkdir(join(root, 'fixture-dep'));
  await json(join(root, 'fixture-dep/package.json'), { name: 'fixture-dep', version: '1.0.0' });
  manifest.dependencies['fixture-dep'] = 'file:./fixture-dep';
  await json(join(root, 'package.json'), manifest);
  execPnpm(['install', '--offline', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'],
    { cwd: root, env, preferPath: true });

  execPnpm(['run', 'smoke'], { cwd: root, env, preferPath: true });

  assert.equal(existsSync(join(root, 'script-ran')), true);
  assert.equal(existsSync(join(root, 'install-ran')), false,
    'running a repository script must leave dependency installation explicit');
  assert.throws(() => execPnpm(['install', '--offline', '--frozen-lockfile'],
    { cwd: root, env, preferPath: true }));
  assert.equal(existsSync(join(root, 'install-ran')), true,
    'explicit installation must still run and report failing lifecycle hooks');
});
