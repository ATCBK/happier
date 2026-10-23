import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execPnpm } from '../workspaces/execPnpmCommand.mjs';
import ts from 'typescript';
import { parse } from 'yaml';

test('migration installs both host libc optional variants without adding foreign OS or CPU targets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-pnpm-host-libc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/cli'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true,
    workspaces: ['apps/*'], dependencies: {}, devDependencies: {}, scripts: {} }));
  await writeFile(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
  const transform = fileURLToPath(new URL('./migratePnpmConfig.mjs', import.meta.url));
  execFileSync(process.execPath, [transform, root], { stdio: 'pipe' });
  const configPath = join(root, 'pnpm-workspace.yaml');
  const first = await readFile(configPath, 'utf8');
  assert.deepEqual(parse(first).supportedArchitectures, {
    os: ['current'], cpu: ['current'], libc: ['glibc', 'musl'],
  });
  execFileSync(process.execPath, [transform, root], { stdio: 'pipe' });
  assert.equal(await readFile(configPath, 'utf8'), first);
});

test('only root Yarn resolutions become overrides; dormant workspace pins are reported and removed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-pnpm-root-resolutions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/cli'), { recursive: true });
  await mkdir(join(root, 'apps/other'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true,
    workspaces: ['apps/*'], dependencies: {}, devDependencies: {}, scripts: {},
    resolutions: { lodash: '4.18.1' } }));
  const cliPath = join(root, 'apps/cli/package.json');
  const cli = { name: '@happier-dev/cli', resolutions: {
    'whatwg-url': '14.2.0', 'parse-path': '7.0.3', '@types/parse-path': '7.0.3',
  } };
  await writeFile(cliPath, JSON.stringify(cli));
  const otherPath = join(root, 'apps/other/package.json');
  await writeFile(otherPath, JSON.stringify({ name: 'other', resolutions: { lodash: '5.0.0' } }));
  const transform = fileURLToPath(new URL('./migratePnpmConfig.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [transform, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const configPath = join(root, 'pnpm-workspace.yaml');
  const first = await readFile(configPath, 'utf8');
  const { overrides } = parse(first);
  assert.equal(overrides.lodash, '4.18.1', 'a workspace must not replace a root resolution');
  for (const name of Object.keys(cli.resolutions)) assert.equal(overrides[name], undefined);
  for (const file of ['apps/cli/package.json', 'apps/other/package.json']) {
    assert.ok(result.stderr.replaceAll('\\', '/').includes(file), 'report each ignored workspace owner');
    assert.equal(JSON.parse(await readFile(join(root, file), 'utf8')).resolutions, undefined);
  }
  // A late workspace-only pin must not clear already migrated root overrides.
  await writeFile(cliPath, JSON.stringify(cli));
  execFileSync(process.execPath, [transform, root], { stdio: 'pipe' });
  assert.equal(await readFile(configPath, 'utf8'), first);
});

test('nested Yarn resolutions retain the audited parent version and scoped package names', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-pnpm-resolutions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/cli'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true,
    workspaces: ['apps/*'], dependencies: {}, devDependencies: {}, scripts: {}, resolutions: {
      '**/minio/fast-xml-parser/fast-xml-builder': '1.1.7',
      '**/@prisma/config/effect': '3.22.2',
      '**/socket.io/socket.io-adapter': '2.5.8',
      '**/@scope/package': '1.0.0',
    } }));
  await writeFile(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
  const transform = fileURLToPath(new URL('./migratePnpmConfig.mjs', import.meta.url));
  execFileSync(process.execPath, [transform, root]);
  const configPath = join(root, 'pnpm-workspace.yaml');
  const first = await readFile(configPath, 'utf8');
  const { overrides } = parse(first);
  assert.equal(overrides['fast-xml-parser@5.7.0>fast-xml-builder'], '1.1.7');
  assert.equal(overrides['fast-xml-parser>fast-xml-builder'], undefined);
  assert.equal(overrides['@prisma/config>effect'], '3.22.2');
  assert.equal(overrides['socket.io>socket.io-adapter'], '2.5.8');
  assert.equal(overrides['@scope/package'], '1.0.0');
  execFileSync(process.execPath, [transform, root]);
  assert.equal(await readFile(configPath, 'utf8'), first);
});

test('unrepresentable Yarn ancestry fails before changing dependency inputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-pnpm-resolution-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/cli'), { recursive: true });
  const manifestPath = join(root, 'package.json');
  const manifest = JSON.stringify({ name: 'fixture', private: true, workspaces: ['apps/*'],
    dependencies: {}, devDependencies: {}, scripts: {}, resolutions: {
      '**/@fastify/otel/minimatch/brace-expansion': '5.0.12',
    } });
  await writeFile(manifestPath, manifest);
  await writeFile(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
  const transform = fileURLToPath(new URL('./migratePnpmConfig.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [transform, root], { stdio: 'pipe' }),
    (error) => error.status !== 0 && /Cannot preserve Yarn resolution scope/.test(String(error.stderr)));
  assert.equal(await readFile(manifestPath, 'utf8'), manifest);
  assert.equal(existsSync(join(root, 'pnpm-workspace.yaml')), false);
});

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

test('migration preserves the shared Yarn Vite identity for Vitest and vite-node without overriding other Vite consumers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-pnpm-vite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/cli'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true,
    workspaces: ['apps/*'], dependencies: {}, devDependencies: { vite: '7.3.1' }, scripts: {} }));
  await writeFile(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
  const transform = fileURLToPath(new URL('./migratePnpmConfig.mjs', import.meta.url));
  execFileSync(process.execPath, [transform, root]);
  const configPath = join(root, 'pnpm-workspace.yaml');
  const first = await readFile(configPath, 'utf8');
  const { overrides } = parse(first);
  assert.equal(overrides['vitest@3.2.4>vite'], '7.3.1');
  assert.equal(overrides['vite-node@3.2.4>vite'], '7.3.1');
  assert.equal(overrides.vite, undefined, 'unrelated Vite 6 consumers retain their own compatible version');
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
