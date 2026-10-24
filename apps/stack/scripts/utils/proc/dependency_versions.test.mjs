import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import * as dependencies from './dependency_refresh.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { beginPendingSourceStart } from '../../runtime/shared/pending_source_start.mjs';

// The baseline run exercises the existing in-place owner with these same
// observable assertions. It cannot turn a missing export into RED evidence.
const versionOwner = process.env.HAPPIER_TEST_DEPENDENCY_VERSION_BASELINE === '1' ? {
  async prepareDependencyVersion(options, prepare) {
    await dependencies.withDependencyRefresh(options, ({ env }) => prepare({ ...options,
      env: { ...env, pnpm_config_package_import_method: 'copy' } }));
    return { dependencyRoot: options.installDir, dependencyIdentity: 'in-place', env: options.env };
  },
  async readSelectedDependencyVersion(options) {
    const state = await dependencies.inspectDependencyRefresh(options);
    return state.admitted && !state.required ? { dependencyRoot: options.installDir } : null;
  },
  readInheritedDependencyVersion: async options => ({ dependencyRoot: options.installDir }),
} : dependencies;

async function setup(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dependency-version-' });
  const installDir = fixture.path('source');
  await mkdir(installDir);
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@12.14.0',
    happier: { installFreshnessInputs: ['prepare-input'] } }));
  await writeFile(join(installDir, 'pnpm-lock.yaml'), 'A');
  await writeFile(join(installDir, 'prepare-input'), 'original');
  const env = { ...process.env, HAPPIER_STACK_PM_CACHE_BASE_DIR: fixture.path('cache'), HAPPIER_DEV_TARGET_EXECUTION: '' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  delete env.HAPPIER_DEPENDENCY_VERSION_ROOT;
  delete env.HAPPIER_DEPENDENCY_VERSION_ID;
  delete env.HAPPIER_DEPENDENCY_SOURCE_ROOT;
  return { fixture, installDir, env };
}

async function install({ installDir, env }) {
  assert.equal(env.pnpm_config_package_import_method, 'copy', 'preparation must not share writable store inodes');
  const version = await readFile(join(installDir, 'pnpm-lock.yaml'), 'utf8');
  for (const dir of ['node_modules/example', 'apps/ui/node_modules/example']) {
    await mkdir(join(installDir, dir), { recursive: true });
    await writeFile(join(installDir, dir, 'index.js'), `module.exports = ${JSON.stringify(version)};`);
  }
  await writeFile(join(installDir, 'generated-output'), 'private generated output');
}

test('A remains consumable while B prepares, including package-local and later child resolution', async t => {
  const { fixture, installDir, env } = await setup(t);
  const a = await versionOwner.prepareDependencyVersion({ installDir, env, signal: t.signal }, install);
  const requireA = createRequire(join(a.dependencyRoot, 'apps/ui/consumer.cjs'));
  assert.equal(requireA('example'), 'A');
  await writeFile(join(installDir, 'pnpm-lock.yaml'), 'B');
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const preparing = versionOwner.prepareDependencyVersion({ installDir, env, signal: t.signal }, async input => {
    enter();
    await gate;
    await install(input);
  });
  let b;
  try {
    await entered;
    const selected = await versionOwner.readSelectedDependencyVersion({ installDir, env });
    assert.equal(selected?.dependencyRoot, a.dependencyRoot, 'A must stay admitted throughout B preparation');
    assert.equal(createRequire(join(selected.dependencyRoot, 'later-child.cjs'))('example'), 'A');
    assert.equal(await readFile(join(installDir, 'prepare-input'), 'utf8'), 'original');
    assert.equal(dependencies.isDependencyRefreshLockActive({ installDir, env }), false,
      'private preparation must hold no installed-tree lifetime custody');
  } finally { release(); b = await preparing; }
  assert.notEqual(a.dependencyIdentity, b.dependencyIdentity);
  assert.equal(createRequire(join(b.dependencyRoot, 'apps/ui/later.cjs'))('example'), 'B');
  assert.equal(requireA('example'), 'A');
  assert.ok(b.dependencyRoot.startsWith(fixture.path('cache')));
  assert.equal(b.env.HAPPIER_DEPENDENCY_VERSION_ROOT, b.dependencyRoot);
  assert.equal(b.env.HAPPIER_DEPENDENCY_VERSION_ID, b.dependencyIdentity);
  assert.equal(b.env.HAPPIER_DEPENDENCY_SOURCE_ROOT, installDir);
  assert.equal((await versionOwner.readInheritedDependencyVersion({ installDir, env: a.env })).dependencyRoot, a.dependencyRoot,
    'later children retain the admitted parent version after current selection changes');
});

test('A pending source start registers and publishes before gated B preparation finishes', { timeout: 10000 }, async t => {
  const { fixture, installDir, env: sourceEnv } = await setup(t);
  const stackBaseDir = fixture.path('stacks', 'a');
  const env = { ...sourceEnv, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_REPO_DIR: installDir,
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' };
  await mkdir(stackBaseDir, { recursive: true });
  await writeFile(join(stackBaseDir, 'env'), `HAPPIER_STACK_REPO_DIR=${installDir}\n`);
  const a = await versionOwner.prepareDependencyVersion({ installDir, env, signal: t.signal }, install);
  await writeFile(join(installDir, 'pnpm-lock.yaml'), 'B');
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let finished = false;
  const preparing = versionOwner.prepareDependencyVersion({ installDir, env, signal: t.signal }, async input => {
    enter();
    await gate;
    await install(input);
    finished = true;
  });
  let pending;
  let start;
  let observedWait;
  const waiting = new Promise(resolve => { observedWait = resolve; });
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk, ...args) => {
    if (String(chunk).startsWith('[local] waiting for dependency refresh lock')) observedWait({ blocked: true });
    return write(chunk, ...args);
  });
  try {
    await entered;
    const startedAt = performance.now();
    start = beginPendingSourceStart({ stackBaseDir, repoDir: installDir, env: a.env });
    const result = await Promise.race([start, waiting]);
    assert.equal('blocked' in result, false, 'A pending source start must not wait for B private preparation');
    pending = result;
    const registrationMs = performance.now() - startedAt;
    assert.equal(finished, false, 'B is still gated when A registers');
    await pending.publishPreparation(async () => {
      assert.equal((await versionOwner.readSelectedDependencyVersion({ installDir, env })).dependencyRoot, a.dependencyRoot);
      assert.equal(createRequire(join(a.dependencyRoot, 'pending-child.cjs'))('example'), 'A');
    });
    await pending.publish(async () => {});
    t.diagnostic(`A pending registration and publication completed while B preparation was held; registrationMs=${registrationMs.toFixed(3)}`);
  } finally {
    release();
    await preparing;
    pending ??= await start;
    await pending?.dispose();
  }
});

for (const failure of ['throw', 'abort', 'inputs-changed']) test(`${failure} during B preparation preserves selected A`, async t => {
  const { installDir, env } = await setup(t);
  const a = await versionOwner.prepareDependencyVersion({ installDir, env, signal: t.signal }, install);
  await writeFile(join(installDir, 'pnpm-lock.yaml'), 'B');
  const cancellation = new AbortController();
  await assert.rejects(versionOwner.prepareDependencyVersion({ installDir, env, signal: cancellation.signal }, async input => {
    await install(input);
    if (failure === 'throw') throw new Error('failed preparation boundary');
    if (failure === 'abort') cancellation.abort();
    if (failure === 'inputs-changed') await writeFile(join(installDir, 'pnpm-lock.yaml'), 'C');
  }), error => failure === 'throw' ? error.message === 'failed preparation boundary'
    : failure === 'abort' ? error.name === 'AbortError' : error.code === 'HAPPIER_DEPENDENCY_INPUTS_CHANGED');
  assert.equal((await versionOwner.readSelectedDependencyVersion({ installDir, env }))?.dependencyRoot, a.dependencyRoot,
    'failed preparation must leave A admitted');
  assert.equal(createRequire(join(a.dependencyRoot, 'late.cjs'))('example'), 'A');
  assert.equal((await readdir(join(a.dependencyRoot, '..'))).length, 1, 'failed private attempt is discarded');
});

test('reuse follows projected install inputs and cannot admit a missing readiness marker', async t => {
  const { installDir, env } = await setup(t);
  let preparations = 0;
  const prepare = async input => { preparations++; await install(input); };
  const a = await versionOwner.prepareDependencyVersion({ installDir, env }, prepare);
  const manifest = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
  manifest.description = 'runtime-only edit';
  await writeFile(join(installDir, 'package.json'), JSON.stringify(manifest));
  assert.equal((await versionOwner.prepareDependencyVersion({ installDir, env }, prepare)).dependencyRoot, a.dependencyRoot);
  assert.equal(preparations, 1, 'no install for an unchanged canonical projection');
  const markerPath = dependencies.resolveDependencyRefreshMarkerPath(a.dependencyRoot);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  delete marker.dependencyVersion?.published;
  await writeFile(markerPath, JSON.stringify(marker));
  assert.equal(await versionOwner.readSelectedDependencyVersion({ installDir, env }), null);
  await assert.rejects(dependencies.readInheritedDependencyVersion({ installDir, env: a.env }),
    { code: 'HAPPIER_DEPENDENCY_VERSION_UNAVAILABLE' }, 'readiness alone must never grant inherited consumption');
  const repaired = await versionOwner.prepareDependencyVersion({ installDir, env }, prepare);
  assert.notEqual(repaired.dependencyRoot, a.dependencyRoot, 'unadmitted version is never repaired in place');
  assert.equal(preparations, 2);
});

test('private preparation source inputs do not invalidate the legacy in-place admission', async t => {
  const { installDir, env } = await setup(t);
  const generator = join(installDir, 'apps/server/scripts/generateClients.ts');
  await mkdir(join(installDir, 'apps/server/scripts'), { recursive: true });
  await writeFile(generator, 'export const generation = 1;');
  await dependencies.withDependencyRefresh({ installDir, env }, () => install({ installDir,
    env: { ...env, pnpm_config_package_import_method: 'copy' } }));
  const a = await dependencies.prepareDependencyVersion({ installDir, env }, install);
  await writeFile(generator, 'export const generation = 2;');
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir, env })).required, false,
    'stage-one preparation must not schedule an old in-place bootstrap mutation');
  const b = await dependencies.prepareDependencyVersion({ installDir, env }, install);
  assert.notEqual(b.dependencyIdentity, a.dependencyIdentity, 'new physical closures capture producer source changes');
});

test('A → B → A reselects the retained admitted A closure without another preparation', async t => {
  const { installDir, env } = await setup(t);
  let preparations = 0;
  const prepare = async input => { preparations++; await install(input); };
  const a = await dependencies.prepareDependencyVersion({ installDir, env }, prepare);
  await dependencies.withDependencyConsumption({ installDir: a.dependencyRoot, env: a.env, signal: t.signal }, async () => {
    await writeFile(join(installDir, 'pnpm-lock.yaml'), 'B');
    await dependencies.prepareDependencyVersion({ installDir, env }, prepare);
    await writeFile(join(installDir, 'pnpm-lock.yaml'), 'A');
    const restored = await dependencies.prepareDependencyVersion({ installDir, env }, prepare);
    assert.equal(restored.dependencyRoot, a.dependencyRoot, 'rollback must reuse the retained admitted physical A');
    assert.equal(preparations, 2, 'only A and B are prepared');
    assert.equal(createRequire(join(a.dependencyRoot, 'late-retained-child.cjs'))('example'), 'A');
  });
});

test('concurrent preparation never adopts a marker-complete unpublished attempt', { timeout: 10000 }, async t => {
  const { installDir, env } = await setup(t);
  await dependencies.prepareDependencyVersion({ installDir, env }, install);
  await writeFile(join(installDir, 'pnpm-lock.yaml'), 'B');
  let writerEntered;
  const entered = new Promise(resolve => { writerEntered = resolve; });
  let releaseWriter;
  const writerGate = new Promise(resolve => { releaseWriter = resolve; });
  const writer = dependencies.withDependencyRefreshLock({ installDir, env, signal: t.signal }, async () => {
    writerEntered();
    await writerGate;
  });
  await entered;
  let complete;
  const markerComplete = new Promise(resolve => { complete = resolve; });
  let observer;
  const first = dependencies.prepareDependencyVersion({ installDir, env, signal: t.signal }, async input => {
    await install(input);
    const marker = dependencies.resolveDependencyRefreshMarkerPath(input.installDir);
    observer = watch(join(input.installDir, 'node_modules'), { persistent: false }, async () => {
      const record = await readFile(marker, 'utf8').then(JSON.parse).catch(() => null);
      if (record) { observer.close(); complete(record); }
    });
  });
  let second;
  try {
    const marker = await Promise.race([markerComplete, first.then(() => {
      throw new Error('a private candidate published through held source decision custody');
    })]);
    assert.equal(marker.dependencyVersion.published, false, 'readiness alone does not transfer cleanup custody');
    let secondEntered;
    const secondPreparing = new Promise(resolve => { secondEntered = resolve; });
    second = dependencies.prepareDependencyVersion({ installDir, env, signal: t.signal }, async input => {
      await install(input);
      secondEntered();
    });
    const interrupted = new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason), { once: true }));
    await Promise.race([secondPreparing, interrupted]);
  } finally {
    observer?.close();
    releaseWriter();
    await writer;
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.dependencyRoot, b.dependencyRoot, 'the losing private attempt reuses the published winner');
  assert.equal((await dependencies.readSelectedDependencyVersion({ installDir, env })).dependencyRoot, a.dependencyRoot);
  assert.equal(createRequire(join(a.dependencyRoot, 'post-race-child.cjs'))('example'), 'B',
    'cleanup of the losing attempt must not remove the adopted winner');
  assert.equal((await readdir(join(a.dependencyRoot, '..'))).length, 2, 'only ready A and the published B winner remain');
});

test('failed publication revokes its candidate under decision custody before a concurrent caller reuses it', { timeout: 10000 }, async t => {
  const { installDir, env: sourceEnv } = await setup(t);
  const env = { ...sourceEnv, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' };
  const a = await dependencies.prepareDependencyVersion({ installDir, env }, install);
  await writeFile(join(installDir, 'pnpm-lock.yaml'), 'B');
  const selection = dependencies.resolveDependencyVersionSelectionPath(installDir, env);
  let offered;
  const publicationOffered = new Promise(resolve => { offered = resolve; });
  let releaseFailure;
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  let failNext = true;
  const rename = fsPromises.rename;
  // Only the real filesystem publication boundary fails. Capturing, readiness,
  // selection, locking, cleanup and competing preparation run their real path.
  t.mock.method(fsPromises, 'rename', async (from, to) => {
    if (to === selection && failNext) {
      failNext = false;
      offered();
      await failureGate;
      throw Object.assign(new Error('publication filesystem boundary unavailable'), { code: 'ENOSPC' });
    }
    return await rename(from, to);
  });
  syncBuiltinESMExports();
  let waited;
  const waiting = new Promise(resolve => { waited = resolve; });
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk, ...args) => {
    if (String(chunk).startsWith('[local] waiting for dependency refresh lock')) waited();
    return write(chunk, ...args);
  });
  let failedRoot;
  const first = dependencies.prepareDependencyVersion({ installDir, env, signal: t.signal }, async input => {
    failedRoot = input.installDir;
    await install(input);
  });
  let second;
  let results;
  try {
    await Promise.race([publicationOffered, first]);
    second = dependencies.prepareDependencyVersion({ installDir, env, signal: t.signal }, install);
    await Promise.race([waiting, second.then(() => {
      throw new Error('a concurrent caller escaped source decision custody');
    })]);
  } finally {
    releaseFailure();
    results = await Promise.allSettled([first, ...(second ? [second] : [])]);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.code, 'ENOSPC');
  assert.equal(results[1].status, 'fulfilled');
  const b = results[1].value;
  assert.notEqual(b.dependencyRoot, failedRoot, 'the failed builder must never delete an adopted closure');
  assert.equal((await dependencies.readSelectedDependencyVersion({ installDir, env })).dependencyRoot, b.dependencyRoot);
  assert.equal(createRequire(join(a.dependencyRoot, 'still-retained.cjs'))('example'), 'A');
  assert.equal(createRequire(join(b.dependencyRoot, 'after-publication-recovery.cjs'))('example'), 'B');
});

test('failed publication releases source custody before deleting its revoked private tree', { timeout: 10000 }, async t => {
  const { fixture, installDir, env: sourceEnv } = await setup(t);
  const env = { ...sourceEnv, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_REPO_DIR: installDir,
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks') };
  const a = await dependencies.prepareDependencyVersion({ installDir, env }, install);
  await writeFile(join(installDir, 'pnpm-lock.yaml'), 'B');
  const selection = dependencies.resolveDependencyVersionSelectionPath(installDir, env);
  const rename = fsPromises.rename;
  const remove = fsPromises.rm;
  let failedRoot;
  let cleanupEntered;
  const deleting = new Promise(resolve => { cleanupEntered = resolve; });
  let releaseDeletion;
  const deletionGate = new Promise(resolve => { releaseDeletion = resolve; });
  // The OS refuses selection; then real recursive deletion is held so a
  // pending source start can exercise the exposed cleanup interval.
  t.mock.method(fsPromises, 'rename', async (from, to) => {
    if (to === selection) throw Object.assign(new Error('selection filesystem boundary unavailable'), { code: 'ENOSPC' });
    return await rename(from, to);
  });
  t.mock.method(fsPromises, 'rm', async (path, options) => {
    if (path === failedRoot) { cleanupEntered(); await deletionGate; }
    return await remove(path, options);
  });
  syncBuiltinESMExports();
  const preparing = dependencies.prepareDependencyVersion({ installDir, env, signal: t.signal }, async input => {
    failedRoot = input.installDir;
    await install(input);
  });
  let pending;
  let result;
  try {
    await Promise.race([deleting, preparing]);
    assert.equal(dependencies.isDependencyRefreshLockActive({ installDir, env }), false,
      'recursive private cleanup must hold no source decision custody');
    pending = await beginPendingSourceStart({ stackBaseDir: fixture.path('stacks', 'a'), repoDir: installDir, env: a.env });
    await pending.publish(async () => {});
    assert.equal((await dependencies.readSelectedDependencyVersion({ installDir, env })).dependencyRoot, a.dependencyRoot);
  } finally {
    releaseDeletion();
    [result] = await Promise.allSettled([preparing]);
    await pending?.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason.code, 'ENOSPC');
});
