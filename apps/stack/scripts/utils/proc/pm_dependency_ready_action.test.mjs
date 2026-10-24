import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureMinimalMonorepoLayout } from '../../testkit/core/minimal_monorepo_layout.mjs';
import { withDependencyConsumption, withDependencyRefresh } from './dependency_refresh.mjs';
import { ensureDepsInstalled } from './pm.mjs';

async function writePnpmInstallStub(binDir) {
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, 'pnpm');
  await writeFile(
    pnpmPath,
    [
      '#!/usr/bin/env node',
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "if (process.env.HAPPIER_SCOPE_LOG) require('node:fs').appendFileSync(process.env.HAPPIER_SCOPE_LOG, `${process.env.HAPPIER_INSTALL_SCOPE || ''}\\n`);",
      "if (process.argv[2] === '--version') {",
      "  process.stdout.write('12.14.0\\n');",
      '  process.exit(0);',
      '}',
      "if (process.argv[2] === 'install') {",
      "  mkdirSync('node_modules', { recursive: true });",
      "  writeFileSync('node_modules/.pnpm-integrity', 'fixture\\n');",
      '}',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(pnpmPath, 0o755);
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
    writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n'),
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
    writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n', 'utf-8'),
    writeFile(join(root, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/ui"}\n', 'utf-8'),
    writeFile(join(root, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf-8'),
    writeFile(join(root, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n', 'utf-8'),
  ]);
  await writePnpmInstallStub(binDir);

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
    // Remote test lanes can spend more than 500ms scheduling the Pnpm stub under
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
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"private":true,"workspaces":["apps/*"]}\n'),
    writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n'),
    writeFile(join(uiDir, 'package.json'), '{"name":"@happier-dev/app"}\n'),
    mkdir(join(root, 'node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web'), { recursive: true }),
    writePnpmInstallStub(join(root, 'bin')),
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

  await writeFile(join(root, 'pnpm-lock.yaml'), '# changed\n');
  const stale = ensure();
  assert.equal(await settled(stale, 400), 'waiting', 'a stale tree still waits for live read custody');
  release();
  await Promise.all([reader, stale]);
});


for (const installed of [false, true]) test(`dev dependency admission defers a foreign pending refresh only with installed bytes (installed=${installed})`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dependency-pending-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { uiDir } = await ensureMinimalMonorepoLayout(root);
  const storage = join(root, 'stacks');
  const foreign = join(storage, 'foreign');
  await Promise.all([
    mkdir(foreign, { recursive: true }),
    mkdir(join(storage, 'dev'), { recursive: true }),
    writeFile(join(root, 'package.json'), '{"private":true,"workspaces":["apps/*"]}\n'),
    writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n'),
    writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n'),
    writeFile(join(uiDir, 'package.json'), '{"name":"@happier-dev/app"}\n'),
    writePnpmInstallStub(join(root, 'bin')),
  ]);
  await writeFile(join(foreign, 'env'), `HAPPIER_STACK_REPO_DIR=${root}\n`);
  const env = { ...process.env, PATH: [join(root, 'bin'), process.env.PATH || ''].join(delimiter),
    CI: '1', HAPPIER_STACK_HOME_DIR: root, HAPPIER_STACK_STORAGE_DIR: storage,
    HAPPIER_STACK_ENV_FILE: join(storage, 'dev', 'env'),
    HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_PM_CACHE_BASE_DIR: join(root, 'cache'),
    HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  if (installed) {
    await ensureDepsInstalled(uiDir, 'fixture', { env, quiet: true });
    await writeFile(join(root, 'pnpm-lock.yaml'), '# changed\n');
  }
  const { beginPendingSourceStart } = await import('../../runtime/shared/pending_source_start.mjs');
  const pending = await beginPendingSourceStart({ stackBaseDir: foreign, repoDir: root, env });
  t.after(() => pending.dispose());
  const refusal = { code: 'HAPPIER_DEPENDENCY_STACK_START_IN_PROGRESS' };
  await assert.rejects(ensureDepsInstalled(uiDir, 'fixture', { env, quiet: true }), refusal);
  let readyActions = 0;
  const devEnv = { ...env, HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS: '1' };
  const options = { env: devEnv, quiet: true, onDependenciesReady: async () => { readyActions++; } };
  if (installed) {
    assert.deepEqual(await ensureDepsInstalled(uiDir, 'fixture', options),
      { admitted: false, required: true, reason: refusal.code });
    assert.equal(readyActions, 0, 'a deferred refresh cannot publish new dependency readiness');
    await assert.rejects(withDependencyRefresh({ installDir: root, env: devEnv }, async () => {
      assert.fail('a pending source start still protects the installed tree from mutation');
    }), refusal);
  } else {
    await assert.rejects(ensureDepsInstalled(uiDir, 'fixture', options), refusal,
      'a cold startup cannot continue without an installed tree');
  }
  await assert.rejects(ensureDepsInstalled(uiDir, 'fixture', {
    ...options, env: { ...devEnv, HAPPIER_STACK_ENV_FILE: join(foreign, 'env') },
  }), refusal, 'a source start cannot defer its own required preparation');
  await pending.dispose();
  await ensureDepsInstalled(uiDir, 'fixture', options);
  assert.equal(readyActions, 1, 'a later refresh completes after the foreign preparation ends');
});
