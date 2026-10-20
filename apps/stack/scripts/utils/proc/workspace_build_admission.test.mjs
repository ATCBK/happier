import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { withWorkspaceBundleLock, WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { runWorkspaceBuildAdmission, withWorkspaceBuildResources } from './workspace_build_admission.mjs';
import { resolveDependencyRefreshLockPath, withDependencyConsumption, withDependencyRefreshLock } from './dependency_refresh.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { join } from 'node:path';

test('Turbo preserves authenticated build transport context without forwarding unrelated environment', async t => {
  const require = createRequire(import.meta.url);
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? '64' : process.arch;
  const extension = process.platform === 'win32' ? '.exe' : '';
  let turbo;
  for (const name of [`@turbo/${platform}-${arch}`, `turbo-${platform}-${arch}`]) {
    try { turbo = require.resolve(`${name}/bin/turbo${extension}`); break; }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  assert.ok(turbo, 'the installed native Turbo binary is required; the probe never installs dependencies');
  const turboPackage = JSON.parse(await readFile(require.resolve('turbo/package.json'), 'utf8'));
  t.diagnostic(`installed Turbo ${turboPackage.version}`);

  const fixture = await createTempFixture(t, { prefix: 'happier-turbo-build-context-' });
  const packageDir = fixture.path('packages', 'probe');
  await mkdir(packageDir, { recursive: true });
  const contextKeys = [
    'HAPPIER_DEV_TARGET_EXECUTION',
    'HAPPIER_HSTACK_EXECUTION',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE',
    'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD',
    'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES',
    'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED',
    'HAPPIER_BUILD_DEPENDENCY_CUSTODY',
  ];
  const unrelatedKey = 'HAPPIER_UNRELATED_TURBO_CONTEXT_PROBE';
  const config = JSON.parse(await readFile(new URL('../../../../../turbo.json', import.meta.url), 'utf8'));
  const transportConfig = Object.fromEntries(['envMode', 'globalEnv', 'globalPassThroughEnv']
    .filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  await Promise.all([
    writeFile(fixture.path('package.json'), JSON.stringify({ name: 'build-context-probe', private: true,
      packageManager: 'yarn@1.22.22', workspaces: ['packages/*'] })),
    writeFile(fixture.path('yarn.lock'), '# yarn lockfile v1\n'),
    writeFile(fixture.path('turbo.json'), JSON.stringify({ ...transportConfig,
      tasks: { 'context-probe': { cache: false } } })),
    writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-test/build-context-probe',
      version: '1.0.0', scripts: { 'context-probe': 'node probe.cjs' } })),
    // Only harmless sentinels reach this OS boundary. It neither authenticates
    // tokens nor takes locks; the existing admission tests own those checks.
    writeFile(join(packageDir, 'probe.cjs'), `require('node:fs').writeFileSync('context.json', JSON.stringify(
      Object.fromEntries(${JSON.stringify([...contextKeys, unrelatedKey])}.map(key => [key, process.env[key] ?? null]))));`),
  ]);
  const sentinels = Object.fromEntries(contextKeys.map(key => [key, `sentinel:${key}`]));
  const env = { ...process.env, ...sentinels, [unrelatedKey]: 'must-not-be-forwarded',
    TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
  delete env.TURBO_ENV_MODE;
  const child = spawnTestProcess(turbo, ['run', 'context-probe', '--filter=@happier-test/build-context-probe',
    '--cache=local:', '--output-logs=errors-only'], { cwd: fixture.root, env, signal: t.signal,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(status, 0, diagnostics);
  const received = JSON.parse(await readFile(join(packageDir, 'context.json'), 'utf8'));
  assert.equal(received[unrelatedKey], null, 'Turbo must retain strict filtering for unrelated environment');
  assert.deepEqual(received, { ...sentinels, [unrelatedKey]: null },
    'finite descendants must retain placement, native admission and authenticated resource-custody transport');
});

test('held-resource admission probe authenticates inherited dependency readers before allowing capacity waits', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-inherited-reader-admission-' });
  const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_BUILD_DEPENDENCY_CUSTODY: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '[]' };
  await withDependencyConsumption({ installDir: fixture.root, env }, async acquiredEnv => {
    const custody = JSON.parse(acquiredEnv.HAPPIER_BUILD_DEPENDENCY_CUSTODY);
    for (const valid of [true, false]) {
      const child = spawnTestProcess(process.execPath, [fileURLToPath(new URL('./workspace_build_admission.mjs', import.meta.url)), '--held-lock-probe'], {
        env: { ...acquiredEnv, HAPPIER_BUILD_DEPENDENCY_CUSTODY: JSON.stringify(valid ? custody : [...custody.slice(0, 3), 'not-the-owner']) },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const status = await new Promise(resolve => child.once('close', resolve));
      assert.equal(status, valid ? 0 : 1, `the native guard must recognize only authenticated inherited read custody: ${stderr}`);
    }
  });
});

test('development startup production runs locally without joining validation capacity admission including nested compilers', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dev-startup-admission-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  writeFakeBin({ root: fixture.root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "1 73400320\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_HSTACK_EXECUTION: '1', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '[]' };
  const cancellation = new AbortController();
  const compiler = fixture.path('compiler.cjs');
  await writeFile(compiler, 'process.stdout.write("started");');
  const compilerOwner = new URL('../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs', import.meta.url).href;
  const compile = `import {spawnSync} from 'node:child_process';
    import {resolveTypeScriptCliInvocation} from ${JSON.stringify(compilerOwner)};
    const invocation = resolveTypeScriptCliInvocation({args:[],env:process.env,
      requireResolve:()=>${JSON.stringify(fixture.path('compiler-package.json'))},
      readFileSyncImpl:()=>JSON.stringify({bin:{tsc:'./compiler.cjs'}})});
    const command = invocation.command.endsWith('/apps/stack/bin/hstack-exec') ? ${JSON.stringify(launcher)} : invocation.command;
    const result = spawnSync(command,invocation.argsPrefix,{env:process.env,encoding:'utf8'});
    process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??''); process.exit(result.status??1);`;
  let queued;
  const waiting = new Promise(resolve => { queued = resolve; });
  const run = runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', compile],
    locks: [{ path: fixture.path('producer.lock') }], launcherPath: launcher, cwd: fixture.root, env,
    devStartup: true, stdio: ['ignore', 'pipe', 'pipe'], signal: cancellation.signal,
    onStderr: value => { if (String(value).includes('waiting for heavyweight admission')) queued('queued'); } });
  try {
    const outcome = await Promise.race([run, waiting]);
    assert.notEqual(outcome, 'queued', 'Stack startup must not wait behind the validation capacity queue');
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout, 'started');
    assert.deepEqual(await readdir(join(admissionRoot, 'waiters')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
    await assert.rejects(lstat(fixture.path('producer.lock')), { code: 'ENOENT' });
  } finally {
    cancellation.abort();
    await run;
  }
});

for (const legacy of [false, true]) test(`fresh event admission readers cannot overtake a live ${legacy ? 'legacy' : 'typed'} dependency writer ticket`, { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-admission-fairness-' });
  const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_BUILD_DEPENDENCY_CUSTODY: '',
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
      let diagnostics = '';
      child.stderr.on('data', chunk => { diagnostics += chunk; });
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
      assert.equal(diagnostics.split('dependency refresh lock is busy:').length - 1, 1,
        'notification retries must not repeat the same busy diagnostic');
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
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '',
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

test('event admission does not rescan leases for unrelated writes in the shared lock directory', { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-admission-watch-noise-' });
  const lockPath = fixture.path('publisher.lock');
  // Count filesystem reads at the OS boundary: noisy log/queue-lock writes
  // must not turn an idle lease waiter into continuous filesystem work.
  const worker = new URL('./workspace_build_admission.mjs', import.meta.url).href;
  const source = `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    let reads = 0;
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => { if (path === ${JSON.stringify(lockPath)}) reads++; return read(path, ...args); };
    syncBuiltinESMExports();
    process.on('message', () => setTimeout(() => process.send(reads), 50));
    const { runWorkspaceBuildAdmissionWorker } = await import(${JSON.stringify(worker)});
    await runWorkspaceBuildAdmissionWorker(process.argv.slice(1));
    process.disconnect();`;
  await withWorkspaceBundleLock(async () => {
    const child = spawnTestProcess(process.execPath, ['--input-type=module', '-e', source, '--',
      '--worker-events', JSON.stringify([{ path: lockPath }]), 'unused', 'package-dist', '--', process.execPath, '-e', ''],
    { env: buildNativeAdmissionFixtureEnv(), stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'ipc'] });
    const exit = new Promise(resolve => child.once('close', resolve));
    const lines = createInterface({ input: child.stdio[3] });
    const events = lines[Symbol.asyncIterator]();
    const sample = () => new Promise(resolve => { child.once('message', resolve); child.send('sample'); });
    try {
      assert.equal((await events.next()).value, 'busy');
      assert.equal((await events.next()).value, 'released');
      child.stdio[4].write('wait 10000\n');
      const before = await sample();
      for (let index = 0; index < 20; index++) await writeFile(fixture.path('unrelated.log'), String(index));
      assert.equal(await sample(), before, 'unrelated parent-directory events must not read the blocked lease');
    } finally {
      child.stdio[4].end();
      await exit;
      lines.close();
    }
  }, { lockPath });
});

test('an admission capacity waiter ignores publisher lease churn but wakes when a reservation retires', { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-admission-capacity-events-' });
  const lockPath = fixture.path('publisher.lock');
  const root = fixture.path('admission');
  await mkdir(join(root, 'owners', 'holder'), { recursive: true });
  await mkdir(join(root, 'waiters'));
  const child = spawnTestProcess(process.execPath, [fileURLToPath(new URL('./workspace_build_admission.mjs', import.meta.url)),
    '--worker-events', JSON.stringify([{ path: lockPath }]), 'unused', 'package-dist', '--', process.execPath, '-e', ''],
  { env: { ...buildNativeAdmissionFixtureEnv(), HSTACK_ADMISSION_WAIT_ROOT: root },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const exit = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdio[3] });
  const events = lines[Symbol.asyncIterator]();
  try {
    assert.equal((await events.next()).value, 'ready');
    child.stdio[4].write('release\n');
    assert.equal((await events.next()).value, 'released');
    await withWorkspaceBundleLock(async () => {
      const next = events.next();
      child.stdio[4].write('wait 10000\n');
      assert.equal(await Promise.race([next.then(event => event.value), new Promise(resolve => setTimeout(() => resolve('waiting'), 100))]),
        'waiting', 'acquiring an already-available publisher lease does not release admission capacity');
      await rmdir(join(root, 'owners', 'holder'));
      assert.equal((await next).value, 'changed', 'reservation retirement still wakes admission immediately');
    }, { lockPath });
  } finally {
    child.stdio[4].end();
    await exit;
    lines.close();
  }
});
