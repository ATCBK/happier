import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectDependencyRefresh, isDependencyRefreshLockActive, SCRIPTLESS_DEPENDENCY_INSTALL_MODE, withDependencyConsumption, withDependencyRefresh, withDependencyRefreshLock, resolveDependencyRefreshLockPath } from './dependency_refresh.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { withPatchedProcessEnv } from '../../testkit/core/env_scope.mjs';
import { withWorkspaceBuildResources } from './workspace_build_admission.mjs';
import { inspectUiPostinstallOutputs } from './ui_postinstall.mjs';
import { adoptInstalledDependencies } from '../dev_targets/remote_dependency_bootstrap.mjs';

test('dependency refresh installs new verifier dependencies before probing UI outputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-refresh-verifier-prerequisite-' });
  const uiDir = fixture.path('apps', 'ui');
  const verifierDir = join(uiDir, 'tools', 'postinstall');
  const dependencyDir = fixture.path('node_modules', 'verifier-prerequisite');
  await mkdir(verifierDir, { recursive: true });
  await mkdir(dependencyDir, { recursive: true });
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# current dependency inputs\n');
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/app', scripts: { 'postinstall:real': 'node postinstall.mjs' },
  }));
  await writeFile(join(dependencyDir, 'package.json'), '{"type":"module","exports":"./index.mjs"}');
  await writeFile(join(dependencyDir, 'index.mjs'), 'export const oldApi = true;\n');
  await writeFile(join(verifierDir, 'verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs'),
    "import { ready } from 'verifier-prerequisite';\nexport function verifyUiPatchedDependencies() { if (!ready) throw new Error('dependency not installed'); }\n");
  const result = await withDependencyRefresh({ installDir: fixture.root, componentDir: uiDir,
    env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root },
    onDependenciesReady: async () => assert.deepEqual(await inspectUiPostinstallOutputs(uiDir, fixture.root), []),
  }, async () => {
    await writeFile(join(dependencyDir, 'index.mjs'), 'export const ready = true;\n');
  });
  assert.equal(result.refreshed, true);
  assert.equal((await inspectDependencyRefresh({ installDir: fixture.root, componentDir: uiDir })).required, false);
});

test('pnpm lockfile, workspace configuration and patch bytes invalidate installed dependency freshness', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-pnpm-freshness-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root };
  await mkdir(fixture.path('node_modules'));
  await mkdir(fixture.path('patches'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  for (const input of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/dependency.patch']) {
    await writeFile(fixture.path(input), 'initial');
  }
  for (const input of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/dependency.patch']) {
    await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
    assert.equal((await inspectDependencyRefresh({ installDir: fixture.root })).required, false);
    await writeFile(fixture.path(input), 'changed');
    assert.equal((await inspectDependencyRefresh({ installDir: fixture.root })).required, true, input);
  }
});

test('worker pnpm admission cleans an unproven tree once and binds proof to installed metadata', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-worker-pnpm-lineage-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_DEV_TARGET_EXECUTION: '1' };
  const componentDir = fixture.path('apps', 'stack');
  const nodeModules = fixture.path('node_modules');
  const metadata = join(nodeModules, '.modules.yaml');
  const privateSource = fixture.path('packages', 'plugin-sdk', 'node_modules', '@happier-dev', 'protocol');
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@12.14.0' }));
  await mkdir(privateSource, { recursive: true });
  await writeFile(join(privateSource, 'package.json'), '{"name":"@happier-dev/protocol"}');
  const install = async () => {
    await mkdir(join(nodeModules, 'react-test-renderer'), { recursive: true });
    await mkdir(join(nodeModules, 'react'), { recursive: true });
    await writeFile(join(nodeModules, 'react', 'index.js'), 'module.exports = {};\n');
    await writeFile(join(nodeModules, 'react-test-renderer', 'package.json'), '{"name":"react-test-renderer"}');
    // Package-manager output is the external boundary. The real admission,
    // root cleanup, writer custody and warm reuse remain live.
    await writeFile(metadata, 'packageManager: pnpm@12.14.0\nlayoutVersion: 5\nnodeLinker: hoisted\n');
  };
  await install();
  await mkdir(join(nodeModules, '@happier-dev'), { recursive: true });
  await symlink(fixture.path('packages', 'plugin-sdk'), join(nodeModules, '@happier-dev', 'plugin-sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(nodeModules, 'react-test-renderer', 'node_modules', 'react'), { recursive: true });
  await writeFile(join(nodeModules, 'react-test-renderer', 'node_modules', 'react', 'index.js'), 'module.exports = {};\n');
  await writeFile(join(nodeModules, '.yarn-integrity'), '{}');
  // The previous admission proves input freshness, never clean pnpm lineage.
  await withDependencyRefresh({ installDir: fixture.root, componentDir, env: { ...env, HAPPIER_DEV_TARGET_EXECUTION: '' } }, async () => {});
  let installs = 0;
  const refresh = async () => {
    installs++;
    assert.equal(isDependencyRefreshLockActive({ installDir: fixture.root, env }), true);
    await assert.rejects(lstat(nodeModules), { code: 'ENOENT' }, 'the complete root must be cold before pnpm runs');
    await install();
  };
  assert.equal((await withDependencyRefresh({ installDir: fixture.root, componentDir, env }, refresh)).refreshed, true);
  await assert.rejects(lstat(join(nodeModules, 'react-test-renderer', 'node_modules', 'react')), { code: 'ENOENT' });
  assert.equal(await readFile(join(privateSource, 'package.json'), 'utf8'), '{"name":"@happier-dev/protocol"}');
  assert.equal((await withDependencyRefresh({ installDir: fixture.root, componentDir, env }, refresh)).refreshed, false);
  assert.equal((await withDependencyRefresh({ installDir: fixture.root, componentDir, env, onDependenciesReady: async () => {} }, refresh)).refreshed, false);
  assert.equal((await withDependencyRefresh({ installDir: fixture.root, componentDir, env }, refresh)).refreshed, false);
  assert.equal(installs, 1, 'an unchanged proven pnpm installation stays warm');
  assert.deepEqual(await adoptInstalledDependencies({ repoDir: fixture.root, env }), { refreshed: false, reason: 'up-to-date' });
  let queuedAdoption;
  await withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
    queuedAdoption = adoptInstalledDependencies({ repoDir: fixture.root, env });
    const waiters = `${resolveDependencyRefreshLockPath(fixture.root, env)}.waiters`;
    while (!(await readdir(waiters).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).some(name => /^\d+\.json$/.test(name))) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    // Replace manager output after the initial inspection but before admission
    // takes custody. Adoption must never cold-clean bytes it cannot reinstall.
    await writeFile(metadata, 'packageManager: yarn@1.22.22\n');
  });
  await assert.rejects(queuedAdoption, { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
  assert.equal(await readFile(metadata, 'utf8'), 'packageManager: yarn@1.22.22\n', 'queued adoption must leave invalidated installed bytes intact');
  await writeFile(metadata, 'packageManager: yarn@1.22.22\n');
  assert.equal((await inspectDependencyRefresh({ installDir: fixture.root, componentDir, env })).required, true);
  await assert.rejects(adoptInstalledDependencies({ repoDir: fixture.root, env }), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
  assert.equal(await readFile(metadata, 'utf8'), 'packageManager: yarn@1.22.22\n', 'adoption cannot mutate or certify unproven worker bytes');
  await rm(metadata);
  assert.equal((await inspectDependencyRefresh({ installDir: fixture.root, componentDir, env })).required, true);
});

test('readiness without installation shares a long consumer even when source inputs are stale', { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-readonly-dependency-readiness-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# admitted\n');
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  await writeFile(fixture.path('pnpm-lock.yaml'), '# source advanced, installed tree remains coherent\n');
  let enter, release, notifyWriter;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const queuedWriter = new Promise(resolve => { notifyWriter = resolve; });
  t.mock.method(process.stderr, 'write', chunk => {
    if (String(chunk).includes('dependency refresh lock')) notifyWriter('queued-writer');
    return true;
  });
  const consumer = withWorkspaceBuildResources({ dependencyInstallDir: fixture.root, env }, async () => { enter(); await held; });
  let readiness;
  try {
    await entered;
    readiness = withDependencyRefresh({ installDir: fixture.root, env, refreshExisting: false },
      async () => assert.fail('read-only readiness must never install'));
    assert.equal(await Promise.race([readiness.then(() => 'ready'), queuedWriter]), 'ready',
      'a no-install check must not become a writer behind a long finite consumer');
    assert.deepEqual(await readiness, { refreshed: false, reason: 'refresh-disabled' });
    assert.equal((await inspectDependencyRefresh({ installDir: fixture.root })).required, true,
      'read-only admission must not certify newer source inputs');
  } finally { release(); await Promise.allSettled([consumer, readiness].filter(Boolean)); }
});

test('readiness queued during installation remains a reader and waits for complete installed bytes', { timeout: 10000 }, async t => {
  // This independent fixture consumer does not inherit the runner's already
  // admitted finite build or its prohibition on waiting for further resources.
  withPatchedProcessEnv(t, {
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: undefined,
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: undefined,
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: undefined,
    HAPPIER_BUILD_DEPENDENCY_CUSTODY: undefined,
  });
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-install-readiness-order-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  let enter, release, notifyWait;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { notifyWait = resolve; });
  t.mock.method(process.stderr, 'write', chunk => { if (String(chunk).includes('dependency refresh lock')) notifyWait(); return true; });
  const install = withDependencyRefresh({ installDir: fixture.root, env }, async () => {
    await writeFile(fixture.path('node_modules', 'tool'), 'partial'); enter(); await held;
    await writeFile(fixture.path('node_modules', 'tool'), 'complete');
  });
  let check, consumer, checked = false, consumed = false;
  try {
    await entered;
    check = withDependencyRefresh({ installDir: fixture.root, env }, async () => assert.fail('completed install must be reused'))
      .then(result => { checked = true; return result; });
    await waiting;
    const directory = `${resolveDependencyRefreshLockPath(fixture.root, env)}.waiters`;
    const tickets = await readdir(directory);
    const roles = await Promise.all(tickets.filter(name => /^\d+\.json$/.test(name))
      .map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')).priority));
    assert.deepEqual(roles, ['reader'], 'waiting for readiness must not reserve mutation priority');
    consumer = withWorkspaceBuildResources({ dependencyInstallDir: fixture.root, env }, async () => {
      assert.equal(await readFile(fixture.path('node_modules', 'tool'), 'utf8'), 'complete'); consumed = true;
    });
    assert.equal(checked, false); assert.equal(consumed, false, 'an active install excludes consumers');
    release(); await Promise.all([install, check, consumer]);
    assert.deepEqual(await check, { refreshed: false, reason: 'up-to-date' });
    assert.equal(consumed, true);
  } finally { release(); await Promise.allSettled([install, check, consumer].filter(Boolean)); }
});

test('dependency writers reject live inherited read custody instead of waiting on their containing reader', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-read-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: root };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  let inheritedEnv;
  let mutations = 0;
  await withDependencyConsumption({ installDir: root, env, signal: t.signal }, async custody => {
    inheritedEnv = custody;
    let independentMutations = 0;
    await withDependencyRefreshLock({ installDir: join(root, 'independent'), env: custody, signal: t.signal },
      async () => { independentMutations += 1; });
    assert.equal(independentMutations, 1, 'live custody of a different installation must not prohibit its writer');
    const cancellation = new AbortController();
    const attemptedUpgrade = withDependencyRefreshLock({ installDir: root, env: custody, signal: cancellation.signal },
      async () => { mutations += 1; });
    // Cancellation lets the old queued implementation terminate; the owner must
    // reject the impossible upgrade before entering its cancellable wait.
    cancellation.abort();
    await assert.rejects(attemptedUpgrade, { code: 'HSTACK_WORKSPACE_ADMISSION_ORDER' });
    assert.equal(mutations, 0);
    assert.equal(isDependencyRefreshLockActive({ installDir: root, env }), true);
  });
  await withDependencyRefreshLock({ installDir: root, env: inheritedEnv, signal: t.signal }, async () => { mutations += 1; });
  assert.equal(mutations, 1, 'released custody must not prohibit an independent writer');
});

test('finite dependency readers share while queued writers exclude new readers', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-shared-readers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: root };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  let release, releaseSecond;
  const held = new Promise(resolve => { release = resolve; });
  const heldSecond = new Promise(resolve => { releaseSecond = resolve; });
  let firstEntered, secondEntered;
  const first = new Promise(resolve => { firstEntered = resolve; });
  const second = new Promise(resolve => { secondEntered = resolve; });
  const pending = [withDependencyConsumption({ installDir: root, env, signal: t.signal }, async custody => {
    await withDependencyConsumption({ installDir: root, env: custody, signal: t.signal }, async () => {});
    firstEntered(); await held;
  })];
  let writerEntered = false, lateEntered = false;
  try {
    await first;
    pending.push(withDependencyConsumption({ installDir: root, env, signal: t.signal }, async () => { secondEntered(); await heldSecond; }));
    assert.equal(await Promise.race([second.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]), true,
      'independent finite readers must enter concurrently');
    pending.push(withDependencyRefreshLock({ installDir: root, env, signal: t.signal }, async () => { writerEntered = true; }));
    const waiters = `${resolveDependencyRefreshLockPath(root, env)}.waiters`;
    while (!(await readdir(waiters)).some(name => /^\d+\.json$/.test(name))) await new Promise(resolve => setTimeout(resolve, 5));
    pending.push(withDependencyConsumption({ installDir: root, env, signal: t.signal }, async () => {
      assert.equal(writerEntered, true, 'queued writer runs before a new reader'); lateEntered = true;
    }));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(writerEntered, false, 'writer cannot mutate either active reader');
    assert.equal(lateEntered, false);
    release(); await pending[0];
    assert.equal(isDependencyRefreshLockActive({ installDir: root, env }), true, 'remaining reader retains exclusion');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(writerEntered, false, 'first reader leaving does not release the second reader');
    releaseSecond(); await Promise.all(pending);
    assert.equal(lateEntered, true);
    assert.equal(isDependencyRefreshLockActive({ installDir: root, env }), false);
  } finally { release(); releaseSecond(); await Promise.allSettled(pending); }
});

test('queued dependency writers retain FIFO priority over new finite readers', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-writer-priority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: root };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const order = [];
  const pending = [withDependencyConsumption({ installDir: root, env, signal: t.signal }, async () => { enter(); await held; })];
  const queued = async count => {
    const directory = `${resolveDependencyRefreshLockPath(root, env)}.waiters`;
    while ((await readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)))
      .filter(name => /^\d+\.json$/.test(name)).length < count) {
      t.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    await entered;
    pending.push(withDependencyRefreshLock({ installDir: root, env, signal: t.signal }, async () => { order.push('writer-first'); }));
    await queued(1);
    pending.push(withDependencyRefreshLock({ installDir: root, env, signal: t.signal }, async () => { order.push('writer'); }));
    await queued(2);
    pending.push(withDependencyConsumption({ installDir: root, env, signal: t.signal }, async () => { order.push('reader-after'); }));
    await queued(3);
    release();
    await Promise.all(pending);
    assert.deepEqual(order, ['writer-first', 'writer', 'reader-after']);
  } finally { release(); await Promise.allSettled(pending); }
});

for (const writerPriority of [true, false]) test(`dependency refresh waits for its live ${writerPriority ? 'writer' : 'reader'} beyond the former acquisition cutoff`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-owner-lifetime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setInterval'] });
  let notices = '';
  t.mock.method(process.stderr, 'write', chunk => { notices += String(chunk); return true; });
  const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' };
  let releaseOwner;
  let markOwnerStarted;
  const held = new Promise(resolve => { releaseOwner = resolve; });
  const started = new Promise(resolve => { markOwnerStarted = resolve; });
  const owner = withDependencyRefreshLock({ installDir: root, env, writerPriority }, async () => {
    markOwnerStarted();
    await held;
  });
  await started;
  let payloadStarts = 0;
  let outcome = 'pending';
  const contender = withDependencyRefreshLock({ installDir: root, env }, async () => { payloadStarts += 1; })
    .then(() => { outcome = 'completed'; }, error => { outcome = error.message; });
  try {
    // OS clock/timer boundaries advance the waiting duration while retaining
    // the real live owner and its real filesystem lock.
    clock += 240_001;
    t.mock.timers.tick(5_000);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(outcome, 'pending', 'a live dependency owner governs admission, not a subordinate acquisition deadline');
    assert.equal(payloadStarts, 0, 'a waiting contender must not start authoritative installation');
    assert.match(notices, new RegExp(`dependency refresh lock.*pid=${process.pid}.*heldMs=.*heartbeatAgeMs=`),
      'dependency consumers must see the existing owner diagnostic while waiting');
    // Synchronous Pnpm can delay an exclusive holder's JavaScript heartbeat;
    // shared-reader timestamps change only on membership changes. Neither
    // timestamp becoming old proves that the real owner has departed.
    clock += 240_001;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(outcome, 'pending', 'a delayed heartbeat must not let a contender replace a live installer');
    assert.equal(payloadStarts, 0);
    assert.equal(isDependencyRefreshLockActive({ installDir: root }), true);
    releaseOwner();
    await Promise.all([owner, contender]);
    assert.equal(outcome, 'completed');
    assert.equal(payloadStarts, 1);
  } finally {
    releaseOwner();
    await Promise.allSettled([owner, contender]);
  }
});

test('dependency readiness is published only after postinstall completion and remains stale on failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-postinstall-publication-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"fixture","private":true}\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  const patchedPath = join(root, 'node_modules', 'streamingReveal.js');
  let failPostinstall = true;
  const refresh = () => withDependencyRefresh({
    installDir: root,
    onDependenciesReady: async () => {
      assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
        'a concurrent reader must not admit unpatched dependencies while postinstall is pending');
      if (failPostinstall) throw new Error('postinstall failed');
      await writeFile(patchedPath, 'export const patched = true;\n');
    },
  }, async () => {});
  await assert.rejects(refresh(), /postinstall failed/);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true);
  failPostinstall = false;
  assert.equal((await refresh()).refreshed, true);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
  assert.match(await readFile(patchedPath, 'utf8'), /patched/);
  failPostinstall = true;
  await assert.rejects(refresh(), /postinstall failed/);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
    'failed warm prerequisite repair must also withdraw the previous ready marker');
  let skippedInstalls = 0;
  const readyOnly = await withDependencyRefresh({ installDir: root, refreshExisting: false,
    onDependenciesReady: async () => await writeFile(patchedPath, 'export const patched = true;\n') },
  async () => { skippedInstalls += 1; });
  assert.equal(skippedInstalls, 0, 'ready-only repair must preserve an explicit no-install request');
  assert.equal(readyOnly.refreshed, false);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
    'repairing outputs without installing stale dependency inputs cannot certify the tree');
  await withDependencyRefresh({ installDir: root }, async () => {});
  const admittedPath = join(root, 'node_modules', '.happier-stack-dependencies-ready');
  const admittedState = JSON.parse(await readFile(admittedPath, 'utf8'));
  await withDependencyRefresh({ installDir: root, installMode: SCRIPTLESS_DEPENDENCY_INSTALL_MODE,
    onDependenciesReady: async () => await writeFile(patchedPath, 'export const patched = true;\n') },
  async () => assert.fail('warm full admission must satisfy scriptless preparation without extraction'));
  assert.deepEqual(JSON.parse(await readFile(admittedPath, 'utf8')), admittedState,
    'warm scriptless completion must retain the full admission identity when no extraction occurred');
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
  await writeFile(join(root, 'pnpm-lock.yaml'), '# changed source, prior installed tree remains coherent\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  await withDependencyRefresh({ installDir: root, refreshExisting: false,
    onDependenciesReady: async () => await writeFile(patchedPath, 'export const patched = true;\n') },
  async () => assert.fail('last-green repair must not install changed source inputs'));
  assert.deepEqual(JSON.parse(await readFile(admittedPath, 'utf8')), admittedState,
    'successful ready-only repair preserves prior admission, never certifies changed source inputs');
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
    'the normal installer must still refresh changed inputs after last-green repair');
});

test('source edits during and after installation preserve dependency readiness', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-password-source-freshness-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  for (const component of ['ui', 'cli', 'server']) {
    const dir = join(root, 'apps', component);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `fixture-${component}` }));
  }
  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(join(protocolDir, 'src', 'auth'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture', private: true, workspaces: ['apps/*', 'packages/*'],
  }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  // Real package metadata is the production boundary: the freshness owner must
  // observe this asset dependency, not a test-only declaration of its inputs.
  await cp(new URL('../../../../../packages/protocol/package.json', import.meta.url), join(protocolDir, 'package.json'));
  await cp(new URL('../../../../ui/package.json', import.meta.url), join(root, 'apps', 'ui', 'package.json'));
  const workerPath = join(root, 'apps', 'ui', 'sources', 'auth', 'password', 'passwordKdf.worker.ts');
  await mkdir(join(workerPath, '..'), { recursive: true });
  await writeFile(workerPath, 'export const sourceRevision = 1;\n');
  const codecPath = join(protocolDir, 'src', 'auth', 'accountPasswordCredential.ts');
  await writeFile(codecPath, 'export const codecRevision = 1;\n');
  await withDependencyRefresh({ installDir: root }, async () => {
    await writeFile(codecPath, 'export const codecRevision = 2;\n');
    await writeFile(workerPath, 'export const sourceRevision = 2;\n');
  });
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
  await writeFile(codecPath, 'export const codecRevision = 3;\n');
  await writeFile(workerPath, 'export const sourceRevision = 3;\n');
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false,
    'source asset compilation owns its last-green output, not installed dependency identity');
  await writeFile(join(root, 'pnpm-lock.yaml'), '# dependency change\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
    'lockfile changes still require an explicit dependency refresh');
});

for (const scope of ['workspace', 'root']) test(`${scope} dependency freshness ignores runtime exports and commands but observes install inputs`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-workspace-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const component of ['ui', 'cli', 'server']) {
    await mkdir(join(root, 'apps', component), { recursive: true });
    await writeFile(join(root, 'apps', component, 'package.json'), JSON.stringify({ name: `fixture-${component}` }));
  }
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'packages', 'fixture'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  const manifestPath = scope === 'root' ? join(root, 'package.json') : join(root, 'packages', 'fixture', 'package.json');
  const manifest = { name: 'workspace-fixture', version: '1.0.0', dependencies: { a: '1', b: '2' },
    ...(scope === 'root' ? { private: true, workspaces: ['apps/*', 'packages/*'] } : {}),
    scripts: { postinstall: 'patch-fixture', test: 'old-test', ...(scope === 'root' ? { prepare: 'prepare-fixture', prepublish: 'publish-fixture' } : {}) },
    exports: { '.': './src/index.js' } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await withDependencyRefresh({ installDir: root }, async () => {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, exports: { '.': './dist/index.js' } }));
  });
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false,
    'exports advancing during installation do not supersede admitted install inputs');
  const changed = { ...manifest, exports: { '.': './dist/index.js', './new': './dist/new.js' }, main: './dist/index.js',
    types: './dist/index.d.ts', scripts: { ...manifest.scripts, test: 'new-test', build: 'build-fixture' },
    dependencies: { b: '2', a: '1' } };
  await writeFile(manifestPath, JSON.stringify(changed, null, 2));
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false,
    'runtime entry points, non-install commands, formatting and dependency map order do not require installation');
  await withDependencyRefresh({ installDir: root }, async () => assert.fail('exports-only edits must not install'));
  const mutations = [
    { name: 'renamed-fixture' }, { version: '2.0.0' }, { dependencies: { a: '2', b: '2' } },
    { devDependencies: { c: '1' } }, { optionalDependencies: { c: '1' } }, { peerDependencies: { c: '1' } },
    { peerDependenciesMeta: { c: { optional: true } } }, { bin: './cli.js' }, { directories: { bin: './bin' } },
    { workspaces: ['nested/*'] }, { resolutions: { c: '1' } }, { overrides: { c: '1' } },
    { packageManager: 'pnpm@12.14.0' }, { engines: { node: '>=24' } }, { os: ['linux'] }, { cpu: ['x64'] },
    { flat: true }, { bundledDependencies: ['a'] }, { bundleDependencies: ['b'] },
    ...['preinstall', 'install', 'postinstall', ...(scope === 'root' ? ['prepare', 'prepublish'] : [])]
      .map(stage => ({ scripts: { ...changed.scripts, [stage]: 'changed-install' } })),
  ];
  for (const mutation of mutations) {
    await writeFile(manifestPath, JSON.stringify({ ...changed, ...mutation }));
    assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
      `install-relevant change ${Object.keys(mutation)[0]} must remain stale`);
  }
});

test('workspace projection re-evaluates admitted raw v6 inputs without invalidating an unchanged install', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-workspace-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const component of ['ui', 'cli', 'server']) {
    await mkdir(join(root, 'apps', component), { recursive: true });
    await writeFile(join(root, 'apps', component, 'package.json'), JSON.stringify({ name: `fixture-${component}` }));
  }
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['apps/*'] }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  await withDependencyRefresh({ installDir: root }, async () => {});
  const before = await inspectDependencyRefresh({ installDir: root });
  const marker = JSON.parse(await readFile(before.markerPath, 'utf8'));
  const legacyInputs = marker.inputs.map(({ installDigest, ...input }) => input);
  await writeFile(before.markerPath, JSON.stringify({ ...marker, inputs: legacyInputs }));
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
  await withDependencyRefresh({ installDir: root, onDependenciesReady: async () => {} },
    async () => assert.fail('an admitted unchanged v6 tree must stay valid'));
  await writeFile(join(root, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-cli', exports: { '.': './new.js' } }));
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false,
    'warm prerequisite completion re-evaluates the proven v6 admission as projected inputs without reinstalling');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'fixture-cli', dependencies: { newDep: '1' } }));
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, true,
    'raw-only admission cannot silently certify changed install fields');
});

test('dependency refresh reclaims a lock whose owner exited', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-dependency-lock-exited-owner-'));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  for (const component of ['ui', 'cli', 'server']) {
    const componentDir = join(fixtureRoot, 'apps', component);
    await mkdir(componentDir, { recursive: true });
    await writeFile(join(componentDir, 'package.json'), `{ "name": "fixture-${component}" }\n`, 'utf8');
  }
  await mkdir(join(fixtureRoot, 'node_modules'), { recursive: true });
  await Promise.all([
    writeFile(join(fixtureRoot, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8'),
    writeFile(join(fixtureRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8'),
    writeFile(join(fixtureRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n'),
  ]);

  const lockPath = join(fixtureRoot, '.project', 'tmp', 'dependency-install.lock');
  const moduleUrl = new URL('./dependency_refresh.mjs', import.meta.url).href;
  const script = [
    "import { mkdir, writeFile } from 'node:fs/promises';",
    "import { dirname } from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    `import { withDependencyRefresh } from ${JSON.stringify(moduleUrl)};`,
    `const lockPath = ${JSON.stringify(lockPath)};`,
    'await mkdir(dirname(lockPath), { recursive: true });',
    'const exitedOwner = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });',
    'if (exitedOwner.status !== 0) throw new Error("fixture owner did not exit successfully");',
    'await writeFile(lockPath, JSON.stringify({',
    '  pid: exitedOwner.pid,',
    '  createdAtMs: Date.now(),',
    '  updatedAtMs: Date.now(),',
    '}), "utf8");',
    `await withDependencyRefresh({ installDir: ${JSON.stringify(fixtureRoot)} }, async () => {});`,
    'process.stdout.write("refreshed\\n");',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('dependency refresh did not reclaim the exited-owner lock'));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.equal(stdout, 'refreshed\n');
});

test('dependency refresh lock follows the explicit Stack home environment', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-dependency-lock-home-'));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const installDir = join(fixtureRoot, 'install');
  const stackHomeDir = join(fixtureRoot, 'stack-home');
  const expectedLockDir = join(stackHomeDir, 'cache', 'dependencies');
  await mkdir(join(installDir, 'node_modules'), { recursive: true });
  await Promise.all([
    writeFile(join(installDir, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8'),
    writeFile(join(installDir, 'pnpm-lock.yaml'), '# fixture\n', 'utf8'),
    writeFile(join(installDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n'),
  ]);

  await withDependencyRefresh({
    installDir,
    env: { ...process.env, HAPPIER_STACK_HOME_DIR: stackHomeDir },
  }, async () => {
    const lockNames = await readdir(expectedLockDir);
    assert.equal(lockNames.length, 1);
    assert.match(lockNames[0], /^[a-f0-9]{64}\.lock$/);
  });
});

test('dependency readiness survives relocation of a byte-identical installed tree', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-dependency-relocation-'));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const sourceRoot = join(fixtureRoot, 'source');
  const relocatedRoot = join(fixtureRoot, 'relocated');
  await mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
  await writeFile(join(sourceRoot, 'install-input.txt'), 'fixture input\n', 'utf8');
  await symlink(join(sourceRoot, 'install-input.txt'), join(sourceRoot, 'install-input-link'));
  await Promise.all([
    writeFile(join(sourceRoot, 'package.json'), '{"name":"fixture","private":true,"packageManager":"pnpm@12.14.0","happier":{"installFreshnessInputs":["install-input-link"]}}\n', 'utf8'),
    writeFile(join(sourceRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8'),
    writeFile(join(sourceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n'),
  ]);

  let refreshCount = 0;
  await withDependencyRefresh({ installDir: sourceRoot }, async () => {
    refreshCount += 1;
    await mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
    await writeFile(join(sourceRoot, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.14.0\nnodeLinker: hoisted\n');
  });
  assert.equal(refreshCount, 1);
  const sourceInspection = await inspectDependencyRefresh({ installDir: sourceRoot });
  assert.equal(sourceInspection.required, false);
  const marker = JSON.parse(await readFile(sourceInspection.markerPath, 'utf8'));
  assert.equal(marker.version, 6);
  assert.equal(Object.hasOwn(marker, 'installDir'), false);
  assert.equal(marker.inputs.every((input) => !input.path.includes(sourceRoot)), true);
  assert.equal(JSON.stringify(marker).includes(sourceRoot), false, 'symlink targets must be hashed instead of storing absolute paths');

  await cp(sourceRoot, relocatedRoot, { recursive: true });
  assert.equal(
    (await inspectDependencyRefresh({ installDir: relocatedRoot })).required,
    false,
    'absolute installation paths must not participate in dependency freshness identity',
  );
  await withDependencyRefresh({ installDir: relocatedRoot }, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 1, 'relocating a ready tree must not trigger another install');
});

test('dependency readiness rejects legacy markers and a different toolchain identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-identity-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"name":"fixture","private":true,"packageManager":"pnpm@12.14.0"}\n', 'utf8'),
    writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n', 'utf8'),
    writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n'),
  ]);
  const armIdentity = {
    packageManager: 'pnpm@12.14.0',
    nodeVersion: '24.0.0',
    nodeAbi: '137',
    platform: 'linux',
    architecture: 'arm64',
    installMode: 'development-full-v1',
  };
  const x64Identity = { ...armIdentity, architecture: 'x64' };

  await withDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity }, async () => {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.14.0\nnodeLinker: hoisted\n');
  });
  const admitted = await inspectDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity });
  assert.equal(admitted.required, false);
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, runtimeIdentity: x64Identity })).required,
    true,
    'architecture-sensitive dependency state must not cross worker architectures',
  );

  const marker = JSON.parse(await readFile(admitted.markerPath, 'utf8'));
  await writeFile(admitted.markerPath, `${JSON.stringify({ ...marker, version: 5 })}\n`, 'utf8');
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity })).required,
    true,
    'v5 markers may have admitted scriptless installs as full installs and must be refreshed',
  );
  await writeFile(admitted.markerPath, `${JSON.stringify({
    ...marker,
    version: 4,
    installDir: root,
  })}\n`, 'utf8');
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, runtimeIdentity: armIdentity })).required,
    true,
    'v4 absolute-path markers remain stale on read',
  );
});

test('dependency admission repairs an exact node_modules self-link without reinstalling', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-self-link-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const nodeModules = join(root, 'node_modules');
  await Promise.all([
    mkdir(nodeModules, { recursive: true }),
    writeFile(join(root, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8'),
    writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n', 'utf8'),
    writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n'),
  ]);

  let refreshCount = 0;
  await withDependencyRefresh({ installDir: root }, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 1);
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);

  const invalidLink = join(nodeModules, 'node_modules');
  await symlink(nodeModules, invalidLink, 'dir');
  const corrupted = await inspectDependencyRefresh({ installDir: root });
  assert.equal(corrupted.required, true);
  assert.equal(corrupted.selfReferentialNodeModulesLinkPath, invalidLink);

  const repaired = await withDependencyRefresh({ installDir: root }, async () => {
    refreshCount += 1;
  });
  assert.deepEqual(repaired, {
    refreshed: false,
    reason: 'repaired-self-referential-node-modules-link',
  });
  assert.equal(refreshCount, 1, 'repairing the exact self-link must not run a package install');
  await assert.rejects(() => lstat(invalidLink), { code: 'ENOENT' });
  assert.equal((await inspectDependencyRefresh({ installDir: root })).required, false);
});
