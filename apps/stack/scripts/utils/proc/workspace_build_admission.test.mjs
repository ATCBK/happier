import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { withWorkspaceBundleLock, WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { resolveWorkspaceBuildAdmissionInvocation, runWorkspaceBuildAdmission, withWorkspaceBuildResources } from './workspace_build_admission.mjs';
import { resolveDependencyRefreshLockPath, withDependencyConsumption, withDependencyRefreshLock } from './dependency_refresh.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { join } from 'node:path';

test('batch resource closure covers transitive publishers and detects graph changes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-batch-resource-closure-' });
  for (const app of ['ui', 'cli', 'server']) {
    await mkdir(fixture.path('apps', app), { recursive: true });
    await writeFile(fixture.path('apps', app, 'package.json'), JSON.stringify({ name: `@happier-dev/fixture-${app}`,
      ...(app === 'cli' ? { dependencies: { '@happier-dev/alpha': 'workspace:*' } } : {}) }));
  }
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const name of ['alpha', 'beta', 'unrelated']) {
    await mkdir(fixture.path('packages', name), { recursive: true });
    await writeFile(fixture.path('packages', name, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`,
      ...(name === 'alpha' ? { main: './dist/index.js', scripts: { build: 'node scripts/build.mjs' },
        dependencies: { '@happier-dev/beta': 'workspace:*', '@happier-dev/fixture-cli': 'workspace:*' } } : {}) }));
  }
  const { collectWorkspaceBuildBatchResources, ensureWorkspacePackagesBuiltByName } = await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
  const selected = [fixture.path('apps', 'cli'), fixture.path('apps', 'ui'), fixture.path('packages', 'beta')];
  const before = await collectWorkspaceBuildBatchResources(selected, { admissionClass: 'package-dist' });
  assert.deepEqual(before.packageNames, ['@happier-dev/alpha', '@happier-dev/beta']);
  assert.equal(before.locks.filter(lock => lock.kind === 'dependency').length, 1);
  assert.equal(before.locks.length, 4, 'one dependency reader, bundle publisher and two package publishers');
  assert.equal(before.admissionClass, 'compilation', 'choose the producer requirement before acquiring the lower reader envelope');
  assert.deepEqual(await collectWorkspaceBuildBatchResources([...selected].reverse(), { admissionClass: 'package-dist' }), before);
  assert.equal((await collectWorkspaceBuildBatchResources(selected, { admissionClass: 'compilation-ui' })).admissionClass,
    'compilation-ui', 'a reader envelope that already covers producers is retained');
  assert.deepEqual(before.consumerOnlyPackageNames, ['@happier-dev/fixture-cli', '@happier-dev/fixture-ui']);
  let compilerCalls = 0;
  await withWorkspaceBuildResources({ locks: before.locks, env: buildNativeAdmissionFixtureEnv(), signal: t.signal }, async env => {
    const result = await ensureWorkspacePackagesBuiltByName(fixture.root, before.packageNames, {
      env, buildMode: 'strict', inheritedAdmission: true, visitedNames: before.consumerOnlyPackageNames,
      signal: t.signal, workspaceBuildBoundary: {
        prepareEnv: async (_dir, value) => value,
        // The compiler process is the system boundary; graph traversal,
        // fingerprinting, mounted publication and custody remain real.
        runPackageBuild: async (_dir, { env }) => {
          compilerCalls++;
          await mkdir(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
          await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const ready = true;\n');
        },
      },
    });
    assert.deepEqual(result.built, ['@happier-dev/alpha']);
  });
  assert.equal(compilerCalls, 1, 'consumer self-cycle is skipped without requesting its absent publication lease');
  await writeFile(fixture.path('packages', 'beta', 'package.json'), JSON.stringify({ name: '@happier-dev/beta',
    dependencies: { '@happier-dev/unrelated': 'workspace:*' } }));
  const after = await collectWorkspaceBuildBatchResources(selected);
  assert.notEqual(after.identity, before.identity);
  assert.deepEqual(after.packageNames, ['@happier-dev/alpha', '@happier-dev/beta', '@happier-dev/unrelated']);
  assert.equal(after.locks.length, before.locks.length + 1);
});

for (const failure of ['none', 'lease', 'producer', 'identity', 'capacity']) test(`composed batch inherits its sole reservation and exact publication custody (${failure})`, { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-composed-build-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const lockPath = fixture.path('producer.lock');
  const ownerUrl = new URL('./workspace_build_admission.mjs', import.meta.url).href;
  const leaf = `import {readdir,readFile} from 'node:fs/promises';
    const owners=await readdir(${JSON.stringify(join(admissionRoot, 'owners'))});
    if(owners.length!==1) process.exit(81);
    if((await readFile(${JSON.stringify(join(admissionRoot, 'owners'))}+'/'+owners[0]+'/class','utf8')).trim()!=='compilation-cli') process.exit(82);
    process.stdout.write('producer-entered');process.exit(${failure === 'producer' ? 23 : 0});`;
  const payload = `import {runWorkspaceBuildAdmission} from ${JSON.stringify(ownerUrl)};
    const env={...process.env};
    ${failure === 'lease' ? "delete env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;delete env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES;" : ''}
    ${failure === 'identity' ? 'env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN=String(process.pid)+":0";' : ''}
    const result=await runWorkspaceBuildAdmission({command:process.execPath,args:['--input-type=module','-e',${JSON.stringify(leaf)}],
      launcherPath:${JSON.stringify(launcher)},locks:[{path:${JSON.stringify(failure === 'lease' ? fixture.path('unreserved.lock') : lockPath)}}],dependencyInstallDir:${JSON.stringify(fixture.root)},
      env,inheritedAdmission:true,admissionClass:${JSON.stringify(failure === 'capacity' ? 'compilation-ui' : 'package-dist')},stdio:['ignore','pipe','pipe']});
    process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1);`;
  const result = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', payload],
    launcherPath: launcher, admissionClass: 'compilation-cli', locks: [{ path: lockPath }], dependencyInstallDir: fixture.root,
    env: buildNativeAdmissionFixtureEnv(), signal: t.signal, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, failure === 'none' ? 0 : failure === 'producer' ? 23 : 1, result.stderr);
  assert.equal(result.stdout, ['lease', 'identity', 'capacity'].includes(failure) ? '' : 'producer-entered');
  assert.deepEqual(await readdir(join(admissionRoot, 'owners')), []);
  assert.deepEqual(await readdir(join(admissionRoot, 'waiters')), []);
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
});

test('cancelling an inherited producer reaps the containing reservation and every lease', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-cancel-composed-build-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const lockPath = fixture.path('producer.lock');
  const payload = `import {runWorkspaceBuildAdmission} from ${JSON.stringify(new URL('./workspace_build_admission.mjs', import.meta.url).href)};
    const result=await runWorkspaceBuildAdmission({command:process.execPath,args:['-e','process.stdout.write("producer-started");setInterval(()=>{},1000)'],
      launcherPath:${JSON.stringify(launcher)},locks:[{path:${JSON.stringify(lockPath)}}],dependencyInstallDir:${JSON.stringify(fixture.root)},
      inheritedAdmission:true,env:process.env,stdio:'inherit'});process.exit(result.status??1);`;
  const cancellation = new AbortController();
  const result = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', payload],
    launcherPath: launcher, admissionClass: 'compilation-cli', locks: [{ path: lockPath }], dependencyInstallDir: fixture.root,
    env: buildNativeAdmissionFixtureEnv(), signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'],
    onStdout: value => { if (String(value).includes('producer-started')) cancellation.abort(); } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /producer-started/);
  assert.deepEqual(await readdir(join(admissionRoot, 'owners')), []);
  assert.deepEqual(await readdir(join(admissionRoot, 'waiters')), []);
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
});

test('required inherited admission rejects absent custody instead of creating a reservation', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-required-inheritance-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const result = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['-e', 'process.stdout.write("unexpected")'],
    launcherPath: launcher, inheritedAdmission: true, env: buildNativeAdmissionFixtureEnv(), signal: t.signal,
    stdio: ['ignore', 'pipe', 'pipe'] });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(join(admissionRoot, 'owners')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
  assert.deepEqual(await readdir(join(admissionRoot, 'waiters')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
});

test('resource-blocked batch holds no capacity while the external publisher enters admission', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-batch-external-contention-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const lockPath = fixture.path('producer.lock');
  const cancellation = new AbortController();
  let reportBlocked;
  const blocked = new Promise(resolve => { reportBlocked = resolve; });
  let batch;
  try {
    await withWorkspaceBundleLock(async () => {
      batch = runWorkspaceBuildAdmission({ command: process.execPath, args: ['-e', 'process.stdout.write("batch-entered")'],
        launcherPath: launcher, admissionClass: 'compilation-cli', locks: [{ path: lockPath, errorLabel: 'batch-producer' }],
        env: buildNativeAdmissionFixtureEnv(), signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'],
        onStderr: value => { if (String(value).includes('workspace-lease-busy')) reportBlocked(); } });
      await Promise.race([blocked, batch.then(result => assert.fail(`batch exited before contention: ${result.status}`))]);
      assert.deepEqual(await readdir(join(admissionRoot, 'owners')), [], 'blocked head must not reserve capacity');
      const waiters = await readdir(join(admissionRoot, 'waiters'));
      assert.equal(waiters.length, 1);
      assert.match(await readFile(join(admissionRoot, 'waiters', waiters[0]), 'utf8'), /workspace-busy/);
      const external = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['-e', 'process.stdout.write("external-entered")'],
        launcherPath: launcher, env: buildNativeAdmissionFixtureEnv(), signal: t.signal, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(external.status, 0, external.stderr);
      assert.equal(external.stdout, 'external-entered');
    }, { lockPath, signal: t.signal });
    const result = await batch;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'batch-entered');
    assert.deepEqual(await readdir(join(admissionRoot, 'owners')), []);
    assert.deepEqual(await readdir(join(admissionRoot, 'waiters')), []);
  } finally {
    cancellation.abort();
    await batch;
  }
});

test('build:packages waits for a foreign transitive producer before capacity admission', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-build-packages-contention-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const { resolvePackageCommandPolicy } = await import('../dev_targets/remote_commands.mjs');
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const policy = await resolvePackageCommandPolicy(['pnpm', 'run', 'build:packages', '@happier-dev/protocol', '@happier-dev/transfers'], { repoRoot: root, cwd: root });
  const lockPath = fixture.path('transitive-producer.lock');
  const ownerUrl = new URL('./workspace_build_admission.mjs', import.meta.url).href;
  const payload = `import {runWorkspaceBuildAdmission} from ${JSON.stringify(ownerUrl)};
    const result=await runWorkspaceBuildAdmission({command:process.execPath,args:['-e','process.stdout.write("published")'],
      launcherPath:${JSON.stringify(launcher)},locks:[{path:${JSON.stringify(lockPath)}}],
      env:process.env,stdio:['ignore','pipe','pipe'],onStderr:value=>process.stderr.write(value)});
    process.stdout.write(result.stdout??'');process.exitCode=result.status??1;`;
  const env = buildNativeAdmissionFixtureEnv();
  const cancellation = new AbortController();
  let blocked;
  const waiting = new Promise(resolve => { blocked = resolve; });
  let terminal;
  try {
    await withWorkspaceBundleLock(async () => {
      if (policy.selfPublisher === '1') {
        const child = spawnTestProcess(process.execPath, ['--input-type=module', '-e', payload], { env, signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', value => { stdout += value; });
        child.stderr.on('data', value => { stderr += value; if (String(value).includes('workspace-lease-busy')) blocked(); });
        terminal = new Promise(resolve => child.once('close', status => resolve({ status, stdout, stderr })));
      } else {
        terminal = runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', payload],
          launcherPath: launcher, admissionClass: policy.heavyClass, env, signal: cancellation.signal,
          stdio: ['ignore', 'pipe', 'pipe'], onStderr: value => { if (String(value).includes('workspace-lease-busy')) blocked(); } });
      }
      await Promise.race([waiting, terminal.then(result => assert.fail(`producer terminated instead of waiting before admission: ${result.stderr}`))]);
      assert.deepEqual(await readdir(join(admissionRoot, 'owners')), [], 'foreign publication wait must hold no capacity');
    }, { lockPath, signal: t.signal });
    const result = await terminal;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'published');
    assert.deepEqual(await readdir(join(admissionRoot, 'owners')), []);
    assert.deepEqual(await readdir(join(admissionRoot, 'waiters')), []);
  } finally {
    cancellation.abort();
    await terminal;
  }
});

for (const platform of ['linux', 'win32']) test(`dependency admission selects the canonical reader resource on ${platform}`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-admission-platform-' });
  const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_HOME_DIR: fixture.root };
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  // Platform selection is an OS boundary. The resource/queue implementation
  // remains real; native Windows filesystem execution is a separate check.
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  let invocation;
  try {
    invocation = resolveWorkspaceBuildAdmissionInvocation({ command: process.execPath, args: ['-e', ''],
      dependencyInstallDir: fixture.root, env });
  } finally { Object.defineProperty(process, 'platform', descriptor); }
  const rawLocks = platform === 'win32'
    ? invocation.args[2]
    : invocation.args.find(value => value.startsWith('--workspace-locks=')).slice('--workspace-locks='.length);
  assert.deepEqual(JSON.parse(rawLocks), [{ kind: 'dependency', installDir: fixture.root,
    path: resolveDependencyRefreshLockPath(fixture.root, env) }]);
  if (platform === 'win32') {
    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[1], '--standalone');
  } else {
    assert.equal(invocation.command, '/bin/sh');
    assert.ok(invocation.args.includes('--heavyweight-admission'));
  }
});

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
      packageManager: JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8')).packageManager })),
    writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n'),
    writeFile(fixture.path('pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/probe: {}\n"),
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

test('typecheck declaration phase cannot wait while retaining an inherited package writer', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-declaration-writer-order-' });
  const owned = fixture.path('owned.lock');
  const foreign = fixture.path('foreign.lock');
  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' };
    await withWorkspaceBundleLock(async () => {
      await assert.rejects(withWorkspaceBuildResources({ locks: [{ path: foreign }], env,
        typecheckDeclarationPhase: true }, () => assert.fail('foreign writer must not be acquired')), {
        code: WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE,
      });
    }, { lockPath: foreign, signal: t.signal });
  }, { lockPath: owned, signal: t.signal });
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
