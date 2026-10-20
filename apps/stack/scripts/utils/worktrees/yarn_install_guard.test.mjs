import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { inspectDependencyRefresh } from '../proc/dependency_refresh.mjs';
import { run } from '../proc/proc.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildStackFixtureEnv } from '../../testkit/core/env_scope.mjs';
import { buildStackHarnessEnv, writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { shouldRunYarnInstall, withYarnInstallGuard } from './yarn_install_guard.mjs';

async function touch(path, ms) {
  const d = new Date(ms);
  await utimes(path, d, d);
}

test('workspace install guard restores UI patch and asset bytes before publishing dependency readiness', {
  skip: process.platform === 'win32' ? 'fake package-manager executable uses a POSIX shebang' : false,
}, async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-yarn-ui-postinstall-' });
  for (const component of ['cli', 'server', 'ui']) {
    await mkdir(join(root, 'apps', component), { recursive: true });
    await writeFile(join(root, 'apps', component, 'package.json'), JSON.stringify({ name: `@fixture/${component}` }));
  }
  const uiDir = join(root, 'apps', 'ui');
  await mkdir(join(uiDir, 'patches'), { recursive: true });
  await mkdir(join(uiDir, 'tools'), { recursive: true });
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/app', scripts: { 'postinstall:real': 'node tools/postinstall.mjs' },
    happier: { installFreshnessInputs: ['patches', 'tools'] },
  }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await writeFile(join(root, 'yarn.lock'), '# workspace fixture\n');
  const patchPath = join(uiDir, 'patches', 'markdown.patch');
  const workerSource = join(uiDir, 'tools', 'worker.js');
  const patchedOutput = join(uiDir, 'node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web', 'streamingReveal.js');
  const workerOutput = join(uiDir, 'public', 'worker.js');
  await writeFile(patchPath, 'first patch\n');
  await writeFile(workerSource, 'first worker\n');

  // Yarn is the process boundary. It re-extracts dependency bytes but reuses
  // lifecycle admission; the real guard and UI preparation owners remain live.
  const { binDir } = writeFakeBin({ root, name: 'yarn', content: `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'install') {
  fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
  fs.mkdirSync(path.dirname(${JSON.stringify(patchedOutput)}), { recursive: true });
  fs.writeFileSync(${JSON.stringify(patchedOutput)}, 'pristine dependency\\n');
} else if (args.join(' ') === '-s workspace @happier-dev/app postinstall:real') {
  if (!fs.existsSync(${JSON.stringify(join(root, '.project', 'tmp', 'dependency-install.lock'))})) process.exit(44);
  if (process.env.HAPPIER_TEST_UI_POSTINSTALL_FAIL === '1') process.exit(43);
  fs.copyFileSync(${JSON.stringify(patchPath)}, ${JSON.stringify(patchedOutput)});
  fs.mkdirSync(path.dirname(${JSON.stringify(workerOutput)}), { recursive: true });
  fs.copyFileSync(${JSON.stringify(workerSource)}, ${JSON.stringify(workerOutput)});
} else process.exit(42);
` });
  const env = buildStackHarnessEnv({ binDirs: [binDir], baseEnv: buildStackFixtureEnv({
    stripStackEnv: true, homeDir: join(root, 'home'),
    extraEnv: { HAPPIER_STACK_STACKS_DIR: join(root, 'stacks'), HAPPIER_STACK_ENV_FILE: '', npm_execpath: '' },
  }) });
  const install = (extraEnv = {}) => withYarnInstallGuard({
    installDir: root, componentDir: root, quiet: true, env: { ...env, ...extraEnv },
  }, () => run('yarn', ['install', '--frozen-lockfile'], { cwd: root, env, stdio: 'ignore' }));

  await install();
  assert.equal(await readFile(patchedOutput, 'utf8'), 'first patch\n');
  assert.equal(await readFile(workerOutput, 'utf8'), 'first worker\n');
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
  assert.equal((await install()).refreshed, false);
  await unlink(patchedOutput);
  assert.equal((await install()).refreshed, false);
  assert.equal(await readFile(patchedOutput, 'utf8'), 'first patch\n',
    'a warm installed tree repairs missing UI outputs without reinstalling dependencies');

  await writeFile(patchPath, 'changed patch\n');
  await writeFile(workerSource, 'changed worker\n');
  await install();
  assert.equal(await readFile(patchedOutput, 'utf8'), 'changed patch\n');
  assert.equal(await readFile(workerOutput, 'utf8'), 'changed worker\n');

  await writeFile(workerSource, 'recovered worker\n');
  await assert.rejects(install({ HAPPIER_TEST_UI_POSTINSTALL_FAIL: '1' }));
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
    'failed UI preparation must not certify the re-extracted tree as ready');
  await install();
  assert.equal(await readFile(workerOutput, 'utf8'), 'recovered worker\n');
});

test('guarded installs keep first-party workspace builds out of the dependency writer lock', {
  skip: process.platform === 'win32' ? 'fake package-manager executable uses a POSIX shebang' : false,
}, async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-yarn-install-scope-' });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  await writeFile(join(root, 'yarn.lock'), '# workspace fixture\n');
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const gatePath = join(repoRoot, 'scripts', 'postinstall', 'shouldRunPostinstall.cjs');
  const dependencyRefreshUrl = new URL('../proc/dependency_refresh.mjs', import.meta.url).href;

  // Yarn is the process boundary. Its install runs a first-party workspace postinstall exactly like
  // packages/protocol: the real scope gate decides, and an admitted build takes non-waiting read
  // custody of the real dependency lock. While the guard holds that lock as writer, a build that
  // reaches it would wait for the install that is waiting for it.
  const { binDir } = writeFakeBin({ root, name: 'yarn', content: `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] !== 'install') process.exit(42);
fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
const gate = require(${JSON.stringify(gatePath)});
if (!gate.shouldRunPostinstall({ workspace: 'protocol', scope: process.env.HAPPIER_INSTALL_SCOPE || '' })) process.exit(0);
import(${JSON.stringify(dependencyRefreshUrl)})
  .then(({ withDependencyConsumption }) => withDependencyConsumption({ installDir: process.cwd(), wait: false }, async () => {}))
  .then(() => process.exit(0), () => process.exit(45));
` });
  const env = buildStackHarnessEnv({ binDirs: [binDir], baseEnv: buildStackFixtureEnv({
    stripStackEnv: true, homeDir: join(root, 'home'),
    extraEnv: { HAPPIER_STACK_STACKS_DIR: join(root, 'stacks'), HAPPIER_STACK_ENV_FILE: '', npm_execpath: '' },
  }) });
  delete env.HAPPIER_INSTALL_SCOPE;

  const outcome = await withYarnInstallGuard({ installDir: root, componentDir: root, quiet: true, env },
    ({ env: installEnv }) => run('yarn', ['install', '--frozen-lockfile'], { cwd: root, env: installEnv, stdio: 'ignore' }));

  assert.equal(outcome.refreshed, true);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
});

test('shouldRunYarnInstall returns true when node_modules is missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '#\n', 'utf-8');

  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
});

test('shouldRunYarnInstall bootstraps the canonical snapshot even when legacy integrity is newer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '#\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'x\n', 'utf-8');

  const base = Date.now();
  await touch(join(dir, 'package.json'), base - 10_000);
  await touch(join(dir, 'yarn.lock'), base - 9_000);
  await touch(join(dir, 'node_modules', '.yarn-integrity'), base);

  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
});

test('dependency readiness survives replacement of node_modules by the admitted refresh', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-persistent-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const previousHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_HOME_DIR = join(dir, '.hstack-home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = previousHome;
  });

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });

  let refreshes = 0;
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, async () => {
    refreshes += 1;
    await rm(join(dir, 'node_modules'), { recursive: true, force: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
  });

  const inspection = await inspectDependencyRefresh({ installDir: dir, componentDir: dir });
  assert.equal(inspection.markerPath.startsWith(join(dir, 'node_modules')), true);
  assert.equal(inspection.required, false);
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, async () => {
    refreshes += 1;
  });
  assert.equal(refreshes, 1);
});

test('dependency refresh publishes a superseded generation and schedules one successor', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-successor-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const previousHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_HOME_DIR = join(dir, '.hstack-home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = previousHome;
  });

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });

  let refreshes = 0;
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, async () => {
    refreshes += 1;
    await writeFile(join(dir, 'yarn.lock'), '# changed while installing\n', 'utf-8');
  });

  const superseded = await inspectDependencyRefresh({ installDir: dir, componentDir: dir });
  assert.equal(superseded.required, true);
  const marker = JSON.parse(await readFile(superseded.markerPath, 'utf-8'));
  assert.equal(marker.superseded, true);

  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, async () => {
    refreshes += 1;
  });
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), false);
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, async () => {
    refreshes += 1;
  });
  assert.equal(refreshes, 2);
});

test('dependency freshness ignores timestamp-only changes but detects same-size content changes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-content-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const packagePath = join(dir, 'package.json');
  await writeFile(packagePath, '{"dependencies":{"example":"1.0.0"}}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });

  let refreshes = 0;
  const refresh = async () => {
    refreshes += 1;
  };
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  const originalStats = await stat(packagePath);
  await touch(packagePath, originalStats.mtimeMs + 60_000);
  assert.equal(
    await shouldRunYarnInstall({ installDir: dir, componentDir: dir }),
    false,
    'a sync-only timestamp change must not reinstall unchanged dependencies',
  );

  await writeFile(packagePath, '{"dependencies":{"example":"1.0.1"}}\n', 'utf-8');
  await touch(packagePath, originalStats.mtimeMs + 60_000);
  assert.equal((await stat(packagePath)).size, originalStats.size);
  assert.equal(
    await shouldRunYarnInstall({ installDir: dir, componentDir: dir }),
    true,
    'same-size dependency input changes must invalidate the installed tree',
  );
  assert.equal(refreshes, 1);
});

test('shouldRunYarnInstall returns true when yarn.lock is newer than integrity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '#\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'x\n', 'utf-8');

  const base = Date.now();
  await touch(join(dir, 'node_modules', '.yarn-integrity'), base - 10_000);
  await touch(join(dir, 'yarn.lock'), base);

  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
});

test('shouldRunYarnInstall returns true when patches are newer than integrity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'yarn.lock'), '#\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'x\n', 'utf-8');
  await mkdir(join(dir, 'patches'), { recursive: true });
  await writeFile(join(dir, 'patches', 'a.patch'), 'diff\n', 'utf-8');

  const base = Date.now();
  await touch(join(dir, 'node_modules', '.yarn-integrity'), base - 10_000);
  await touch(join(dir, 'patches', 'a.patch'), base);

  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
});

test('canonical guard detects declared directory additions, changes, and deletions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-yarn-guard-declared-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const previousHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_HOME_DIR = join(dir, '.hstack-home');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = previousHome;
  });

  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ happier: { installFreshnessInputs: ['install-inputs'] } }) + '\n',
    'utf-8',
  );
  await writeFile(join(dir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'old\n', 'utf-8');
  const input = join(dir, 'install-inputs', 'a.txt');

  let refreshes = 0;
  const refresh = async () => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
  };
  await Promise.all([
    withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh),
    withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh),
  ]);
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), false);

  await mkdir(join(dir, 'install-inputs'), { recursive: true });
  await writeFile(input, 'a\n', 'utf-8');
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  const added = join(dir, 'install-inputs', 'b.txt');
  await writeFile(added, 'b\n', 'utf-8');
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  await writeFile(input, 'changed-size\n', 'utf-8');
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh);

  await unlink(added);
  assert.equal(await shouldRunYarnInstall({ installDir: dir, componentDir: dir }), true);
  await withYarnInstallGuard({ installDir: dir, componentDir: dir }, refresh);
  assert.equal(refreshes, 5);
});
