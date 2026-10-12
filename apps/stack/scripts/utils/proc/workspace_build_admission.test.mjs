import assert from 'node:assert/strict';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { withWorkspaceBundleLock, WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { runWorkspaceBuildAdmission, withWorkspaceBuildResources } from './workspace_build_admission.mjs';
import { resolveDependencyRefreshLockPath, withDependencyConsumption, withDependencyRefreshLock } from './dependency_refresh.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';

for (const legacy of [false, true]) test(`fresh event admission readers cannot overtake a live ${legacy ? 'legacy' : 'typed'} dependency writer ticket`, { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-admission-fairness-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_BUILD_DEPENDENCY_CUSTODY: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '[]' };
  const lockPath = resolveDependencyRefreshLockPath(fixture.root, env);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const holder = withDependencyConsumption({ installDir: fixture.root, env, signal: t.signal }, async () => { enter(); await held; });
  const children = [];
  let writer, writerEntered = false;
  try {
    await entered;
    writer = withDependencyRefreshLock({ installDir: fixture.root, env, signal: t.signal }, async () => { writerEntered = true; });
    let ticket;
    while (!ticket) {
      t.signal.throwIfAborted();
      const names = await readdir(`${lockPath}.waiters`).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      ticket = names.find(name => /^\d+\.json$/.test(name));
      if (!ticket) await new Promise(resolve => setTimeout(resolve, 5));
    }
    const identity = JSON.parse(await readFile(`${lockPath}.waiters/${ticket}`, 'utf8'));
    if (legacy) {
      // Already-loaded exclusive owners write the predecessor's untyped record.
      // It is still a live mutation waiter, never permission to join as a reader.
      const { priority, ...legacyIdentity } = identity;
      await writeFile(`${lockPath}.waiters/${ticket}`, JSON.stringify(legacyIdentity));
    }
    for (let index = 0; index < 2; index++) {
      const child = spawnTestProcess(process.execPath, [fileURLToPath(new URL('./workspace_build_admission.mjs', import.meta.url)),
        '--worker-events', JSON.stringify([{ kind: 'dependency', installDir: fixture.root, path: lockPath }]),
        'unused-launcher', 'package-dist', '--', process.execPath, '-e', ''],
      { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
      const exit = new Promise(resolve => child.once('close', resolve));
      children.push({ child, exit });
      const lines = createInterface({ input: child.stdio[3] });
      const events = lines[Symbol.asyncIterator]();
      assert.equal((await events.next()).value, 'busy', 'fresh worker must refuse the pending writer');
      assert.equal((await events.next()).value, 'released');
      child.stdio[4].write('wait 1\n');
      assert.equal((await events.next()).value, 'changed');
      child.stdio[4].write('try\n');
      assert.equal((await events.next()).value, 'busy', 'retry must still refuse the same writer');
      assert.equal((await events.next()).value, 'released');
      const current = JSON.parse(await readFile(`${lockPath}.waiters/${ticket}`, 'utf8'));
      assert.equal(current.createdAtMs, identity.createdAtMs, 'writer retains its ticket across admission retries');
      child.stdio[4].end();
      await exit;
      lines.close();
    }
    assert.equal(writerEntered, false);
    release();
    await Promise.all([holder, writer]);
    assert.equal(writerEntered, true);
    assert.deepEqual(await readdir(`${lockPath}.waiters`), []);
  } finally {
    release();
    for (const { child } of children) child.stdio[4].end();
    await Promise.allSettled([holder, writer, ...children.map(({ exit }) => exit)].filter(Boolean));
  }
});

for (const cancelled of [false, true]) test(`standalone workspace admission releases earlier resources ${cancelled ? 'when cancelled while queued' : 'before waiting for a later publisher'}`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-standalone-workspace-order-' });
  const first = fixture.path('first.lock');
  const second = fixture.path('second.lock');
  const env = { ...process.env, CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '[]',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '' };
  let notifyWaiting;
  const waiting = new Promise(resolve => { notifyWaiting = resolve; });
  const cancellation = new AbortController();
  let build, failure;
  await withWorkspaceBundleLock(async () => {
    build = runWorkspaceBuildAdmission({ command: process.execPath, args: ['-e', 'process.stdout.write("published")'],
      locks: [{ path: first }, { path: second }], cwd: fixture.root, env, signal: cancellation.signal,
      admissionRequired: false, stdio: ['ignore', 'pipe', 'pipe'],
      onStderr: chunk => { if (String(chunk).includes(second)) notifyWaiting(); } });
    await Promise.race([waiting, build.then(result => assert.fail(`publisher exited without waiting: ${result.stderr}`))]);
    try {
      await assert.rejects(lstat(first), { code: 'ENOENT' }, 'a queued multi-resource publisher must release its earlier lease');
      await withWorkspaceBundleLock(() => {}, { lockPath: first, wait: false });
    } catch (error) { failure = error; }
    if (cancelled) {
      cancellation.abort();
      assert.equal((await build).error?.name, 'AbortError');
    }
  }, { lockPath: second });
  const result = await build;
  if (!cancelled) assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, cancelled ? '' : 'published');
  await assert.rejects(lstat(first), { code: 'ENOENT' });
  if (failure) throw failure;
});

test('workspace resource contention never retries an entered publisher', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-workspace-publisher-error-' });
  const lockPath = fixture.path('publisher.lock');
  let entries = 0;
  const failure = new Error('nested publisher is unavailable');
  failure.code = WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE;
  await assert.rejects(withWorkspaceBuildResources({ locks: [{ path: lockPath }] }, async () => {
    entries++;
    throw failure;
  }), error => error === failure);
  assert.equal(entries, 1, 'a writer error must not replay publication');
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
});
