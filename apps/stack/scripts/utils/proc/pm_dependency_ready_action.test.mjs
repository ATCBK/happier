import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureMinimalMonorepoLayout } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { withDependencyConsumption, withDependencyRefresh } from './dependency_refresh.mjs';
import { ensureDepsInstalled } from './pm.mjs';

async function writeYarnInstallStub(binDir) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "if (process.env.HAPPIER_SCOPE_LOG) require('node:fs').appendFileSync(process.env.HAPPIER_SCOPE_LOG, `${process.env.HAPPIER_INSTALL_SCOPE || ''}\\n`);",
      "if (process.argv[2] === '--version') {",
      "  process.stdout.write('1.22.22\\n');",
      '  process.exit(0);',
      '}',
      "if (process.argv[2] === 'install') {",
      "  mkdirSync('node_modules', { recursive: true });",
      "  writeFileSync('node_modules/.yarn-integrity', 'fixture\\n');",
      '}',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
}

test('ensureDepsInstalled serializes dependency-ready actions inside the existing refresh lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-ready-action-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'apps', 'ui');
  const binDir = join(root, 'bin');
  const dependencyLockPath = join(root, '.project', 'tmp', 'dependency-install.lock');
  const cliLockPath = join(root, '.project', 'tmp', 'cli-dist-build.lock');
  await Promise.all([
    mkdir(componentDir, { recursive: true }),
    mkdir(join(root, 'apps', 'cli'), { recursive: true }),
    mkdir(join(root, 'apps', 'server'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      private: true,
      workspaces: ['apps/*'],
    }) + '\n', 'utf-8'),
    writeFile(join(root, 'yarn.lock'), '# fixture\n', 'utf-8'),
    writeFile(join(root, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/ui"}\n', 'utf-8'),
    writeFile(join(root, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf-8'),
    writeFile(join(root, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n', 'utf-8'),
  ]);
  await writeYarnInstallStub(binDir);

  const env = {
    ...process.env,
    PATH: [binDir, String(process.env.PATH ?? '')].filter(Boolean).join(delimiter),
    CI: '1',
    HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_PM_CACHE_BASE_DIR: join(root, 'cache'),
    HAPPIER_SCOPE_LOG: join(root, 'scope.log'),
  };
  const events = [];
  let releaseFirstAction;
  const releaseFirstActionPromise = new Promise((resolve) => {
    releaseFirstAction = resolve;
  });
  let markFirstActionStarted;
  const firstActionStarted = new Promise((resolve) => {
    markFirstActionStarted = resolve;
  });

  const firstEnsure = ensureDepsInstalled(componentDir, 'fixture', {
    quiet: true,
    env,
    onDependenciesReady: async () => {
      assert.equal((await stat(dependencyLockPath)).isFile(), true);
      await assert.rejects(() => stat(cliLockPath), { code: 'ENOENT' });
      events.push('first:action:start');
      markFirstActionStarted();
      await releaseFirstActionPromise;
      events.push('first:action:end');
    },
  });
  await Promise.race([
    firstActionStarted,
    // Remote test lanes can spend more than 500ms scheduling the Yarn stub under
    // machine load. This deadline guards a real deadlock without racing setup.
    delay(5_000).then(() => {
      throw new Error('timed out waiting for the dependency-ready action');
    }),
  ]);

  const secondEnsure = ensureDepsInstalled(componentDir, 'fixture', {
    quiet: true,
    env,
    onDependenciesReady: async () => {
      assert.equal((await stat(dependencyLockPath)).isFile(), true);
      await assert.rejects(() => stat(cliLockPath), { code: 'ENOENT' });
      events.push('second:action');
    },
  });
  await delay(150);
  assert.deepEqual(events, ['first:action:start']);

  releaseFirstAction();
  await Promise.all([firstEnsure, secondEnsure]);
  assert.deepEqual(events, ['first:action:start', 'first:action:end', 'second:action']);
  assert.deepEqual(
    new Set((await (await import('node:fs/promises')).readFile(join(root, 'scope.log'), 'utf8')).split('\n').filter(Boolean)),
    new Set(['cli']),
    'Stack-managed dependency refresh must not run shared-package or server build postinstalls',
  );
});

// A long-lived finite consumer (for example a source Web export) holds shared
// read custody. Startup verifies a current tree and prepares first-party outputs
// without mutating dependencies, so it must not queue as a writer behind it.
for (const [mode, options, env] of [
  ['refresh disabled by the caller', { refreshExisting: false }, {}],
  ['refresh disabled by the environment', {}, { HAPPIER_STACK_SKIP_REFRESH_DEPS: '1' }],
]) test(`ensureDepsInstalled admits a current tree under live read custody and waits for a stale one (${mode})`, { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-current-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { uiDir } = await ensureMinimalMonorepoLayout(root);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"private":true,"workspaces":["apps/*"]}\n'),
    writeFile(join(root, 'yarn.lock'), '# fixture\n'),
    writeFile(join(uiDir, 'package.json'), '{"name":"@happier-dev/app"}\n'),
    mkdir(join(root, 'node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web'), { recursive: true }),
    writeYarnInstallStub(join(root, 'bin')),
  ]);
  await writeFile(join(root, 'node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web', 'streamingReveal.js'), 'export {};');
  const baseEnv = {
    ...process.env,
    PATH: [join(root, 'bin'), String(process.env.PATH ?? '')].filter(Boolean).join(delimiter),
    CI: '1',
    HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_PM_CACHE_BASE_DIR: join(root, 'cache'),
  };
  delete baseEnv.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  // Publish the admission through the owner, then hold live read custody.
  await withDependencyRefresh({ installDir: root, env: baseEnv }, async () => {});
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const readerEntered = new Promise(resolve => { entered = resolve; });
  const reader = withDependencyConsumption({ installDir: root, env: baseEnv, signal: t.signal }, async () => { entered(); await held; });
  t.after(async () => { release(); await reader.catch(() => {}); });
  await readerEntered;

  const ensure = () => ensureDepsInstalled(uiDir, 'fixture', { quiet: true, env: { ...baseEnv, ...env }, ...options });
  const settled = async (promise, ms) => await Promise.race([promise.then(() => 'done'), delay(ms).then(() => 'waiting')]);
  assert.equal(await settled(ensure(), 5_000), 'done', 'a current tree must be verified without waiting for the reader');

  await writeFile(join(root, 'yarn.lock'), '# changed\n');
  const stale = ensure();
  assert.equal(await settled(stale, 400), 'waiting', 'a stale tree still waits for live read custody');
  release();
  await Promise.all([reader, stale]);
});
