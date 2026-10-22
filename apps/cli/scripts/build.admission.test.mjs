import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import { installNativeAdmissionFixture } from '../../stack/scripts/testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../stack/scripts/testkit/core/fake_bin_harness.mjs';
import { spawnTestProcess } from '../../stack/scripts/testkit/core/spawn_test_process.mjs';

async function createCliAdmissionFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-dist-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'apps/cli');
  const lockPath = join(root, '.project/tmp/cli-dist-build.lock');
  await Promise.all([mkdir(join(packageRoot, 'src'), { recursive: true }), mkdir(dirname(lockPath), { recursive: true })]);
  await writeFile(join(root, 'package.json'), '{"private":true}\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli-build-admission-fixture', version: '0.0.0', type: 'module',
    main: './dist/index.mjs', module: './dist/index.mjs',
  }));
  await writeFile(join(packageRoot, 'src/index.ts'), 'export const published = true;\n');
  await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [] } }));
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root });
  await Promise.all(['owners', 'waiters'].map(kind => mkdir(join(admissionRoot, kind), { recursive: true })));
  const memoryPath = join(root, 'memory');
  await writeFile(memoryPath, '1 73400320\n');
  writeFakeBin({ root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  writeFakeBin({ root, name: 'sleep', content: '#!/bin/sh\nexec /bin/sleep 0.02\n' });
  const loader = join(root, 'native-boundary-loader.mjs');
  // Only the physical OS admission endpoint changes. Builder orchestration,
  // input freshness, pkgroll, publication and lease authentication stay real.
  await writeFile(loader, `export async function resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/apps/cli/scripts/build.mjs') && specifier.endsWith('/proc/workspace_build_admission.mjs')) {
      return { url: ${JSON.stringify(pathToFileURL(join(root, 'native-owner/apps/stack/scripts/utils/proc/workspace_build_admission.mjs')).href)}, shortCircuit: true };
    }
    return next(specifier, context);
  }`);
  const api = join(root, 'api.mjs');
  await writeFile(api, `import { buildCliDist } from ${JSON.stringify(new URL('./build.mjs', import.meta.url).href)};
    try { const result = await buildCliDist(); process.stdout.write(JSON.stringify({ completed: true, returnedUndefined: result === undefined })); }
    catch (error) { process.stdout.write(JSON.stringify({ failed: true, exitCode: error.exitCode, signal: error.signal })); process.exitCode = error.exitCode ?? 1; }`);
  const env = { ...process.env,
    PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, FIXTURE_MEMORY: memoryPath,
    NODE_OPTIONS: `--experimental-loader=${loader}`, CI: '', HAPPIER_DEV_TARGET_EXECUTION: '1',
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '', HAPPIER_CLI_BUILD_OUTPUT_DIR: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
    HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev', npm_lifecycle_event: 'build',
  };
  const start = (extraEnv = {}, args = [api]) => {
    const child = spawnTestProcess(process.execPath, args, { cwd: packageRoot, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolveExit => child.once('close', (status, signal) => resolveExit({ status, signal })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM'); await exited; });
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  };
  return { root, packageRoot, lockPath, memoryPath, admissionRoot, start,
    entries: kind => readdir(join(admissionRoot, kind)) };
}

async function waitForCliAdmissionState(fixture, run, condition) {
  await new Promise((resolveReady, reject) => {
    let checking = false;
    const cleanup = () => { for (const watcher of watchers) watcher.close(); run.child.stderr.off('data', check); run.child.off('close', failed); };
    const failed = () => { cleanup(); reject(new Error(`CLI build exited before expected state: ${run.stderr()}`)); };
    const check = async () => {
      if (checking) return;
      checking = true;
      try { if (await condition()) { cleanup(); resolveReady(); } }
      catch (error) { cleanup(); reject(error); }
      finally { checking = false; }
    };
    const watchers = [dirname(fixture.lockPath), fixture.admissionRoot, join(fixture.admissionRoot, 'waiters')].map(path => watch(path, check));
    run.child.stderr.on('data', check);
    run.child.once('close', failed);
    void check();
  });
}

test('default CLI publisher jointly waits for its B lease and admission before compiling and publishing', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createCliAdmissionFixture(t);
  let entered, release;
  const ready = new Promise(resolveReady => { entered = resolveReady; });
  const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolveRelease => { release = resolveRelease; }); }, { lockPath: fixture.lockPath });
  await ready;
  const run = fixture.start();
  try {
    await waitForCliAdmissionState(fixture, run, async () => run.stderr().includes('workspace-lease-busy') && (await fixture.entries('waiters')).length === 1);
    assert.equal(existsSync(`${fixture.lockPath}.priority-claim`), true, 'joint admission priority-claim expectation');
    assert.equal((await fixture.entries('waiters')).length, 1, 'foreign B lease wait must be registered with joint admission');
    assert.deepEqual(await fixture.entries('owners'), []);
    release(); await holder;
    await waitForCliAdmissionState(fixture, run, () => run.stderr().includes('waiting for heavyweight admission'));
    assert.match(run.stderr(), /class=compilation/);
    assert.equal(existsSync(fixture.lockPath), false, 'capacity wait must not retain B');
    await withWorkspaceBundleLock(async () => {
      assert.deepEqual(await fixture.entries('owners'), []);
      assert.equal(existsSync(join(fixture.packageRoot, 'dist')), false);
      await writeFile(fixture.memoryPath, '31457280 73400320\n');
    }, { lockPath: fixture.lockPath });
    assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
    assert.match(run.stdout(), /"completed":true,"returnedUndefined":true/);
    assert.match(await readFile(join(fixture.packageRoot, 'dist/index.mjs'), 'utf8'), /published = true/);
    assert.equal(existsSync(fixture.lockPath), false);
    assert.deepEqual(await fixture.entries('owners'), []);
    assert.deepEqual(await fixture.entries('waiters'), []);
    const lastGreen = await readFile(join(fixture.packageRoot, 'dist/index.mjs'), 'utf8');
    await writeFile(join(fixture.packageRoot, 'src/index.ts'), 'export const = ;\n');
    const failed = fixture.start();
    assert.deepEqual(await failed.exited, { status: 1, signal: null }, failed.stderr());
    assert.match(failed.stdout(), /"failed":true,"exitCode":1,"signal":null/);
    assert.equal(await readFile(join(fixture.packageRoot, 'dist/index.mjs'), 'utf8'), lastGreen);
    assert.deepEqual(await fixture.entries('owners'), []);
    assert.deepEqual(await fixture.entries('waiters'), []);
    assert.equal(existsSync(fixture.lockPath), false);
    await writeFile(fixture.memoryPath, '1 73400320\n');
    const cancelled = fixture.start({ npm_lifecycle_event: 'prepack' });
    await waitForCliAdmissionState(fixture, cancelled, () => cancelled.stderr().includes('waiting for heavyweight admission'));
    assert.equal(existsSync(fixture.lockPath), false);
    process.kill(-cancelled.child.pid, 'SIGTERM');
    assert.deepEqual(await cancelled.exited, { status: null, signal: 'SIGTERM' }, cancelled.stderr());
    assert.equal(await readFile(join(fixture.packageRoot, 'dist/index.mjs'), 'utf8'), lastGreen);
    assert.deepEqual(await fixture.entries('owners'), []);
    assert.deepEqual(await fixture.entries('waiters'), []);
  } finally { release(); await holder; }
});

test('private CLI publisher rejects missing, forged and unrelated authenticated B leases', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createCliAdmissionFixture(t);
  const args = [fileURLToPath(new URL('./build.mjs', import.meta.url)), '--happier-cli-dist-build-worker', '{}'];
  for (const heldLockValue of ['', 'forged-lease']) {
    const run = fixture.start({ HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue }, args);
    assert.deepEqual(await run.exited, { status: 1, signal: null }, run.stderr());
    assert.match(run.stderr(), /requires its authenticated inherited CLI publication lease/);
  }
  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const run = fixture.start({ HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: JSON.stringify([heldLockValue]) }, args);
    assert.deepEqual(await run.exited, { status: 1, signal: null }, run.stderr());
    assert.match(run.stderr(), /requires its authenticated inherited CLI publication lease/);
  }, { lockPath: join(fixture.root, 'unrelated.lock') });
  assert.equal(existsSync(join(fixture.packageRoot, 'dist')), false);
  assert.equal(existsSync(join(fixture.packageRoot, '.tmp.hstack-cli-build-source.incremental')), false);
  assert.deepEqual(await fixture.entries('owners'), []);
});
