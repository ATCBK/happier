import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { withWorkspaceBundleLock } from '../../../packages/cli-common/workspaceBundleLock.mjs';
import { resolveDependencyRefreshLockPath } from './utils/proc/dependency_refresh.mjs';

async function waitForJointAdmission(condition, child, diagnostic) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await condition()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`joint admission exited before the observed condition: ${diagnostic()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`joint admission condition was not reached: ${diagnostic()}`);
}

async function createJointAdmissionFixture(t, available = 9437184, { realRetry = false } = {}) {
  const fixture = await createTempFixture(t, { prefix: 'host-joint-workspace-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const memory = fixture.path('memory');
  await writeFile(memory, `${available} 73400320\n`);
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  // Sleep is the OS boundary for capacity retry. Keep the production decision
  // and FIFO accounting real while allowing this fixture's pressure to change.
  writeFakeBin({ root: fixture.root, name: 'sleep', content: realRetry ? '#!/bin/sh\nexec /bin/sleep "$@"\n' : '#!/bin/sh\nexec /bin/sleep 0.02\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_MEMORY: memory,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const entries = async kind => {
    try { return await readdir(`${admissionRoot}/${kind}`); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const start = (locks, args = ['/bin/sh', '-c', 'printf payload'], admissionClass = 'package-dist', options = []) => {
    const child = spawn('/bin/sh', [launcher, '--heavyweight-admission', `--class=${admissionClass}`, '--machine=worker',
      ...options,
      ...(locks === null ? [] : [`--workspace-locks=${JSON.stringify(locks)}`]), '--', ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const exited = new Promise(resolve => child.once('exit', (status, signal) => resolve({ status, signal })));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  };
  const readWaiter = name => {
    // Native decisions rewrite queue state while holding this OS mutex. Read
    // the same synchronized snapshot instead of racing an in-place rewrite.
    const result = spawnSync('/usr/bin/flock', [`${admissionRoot}/lock`, '/bin/cat', `${admissionRoot}/waiters/${name}`], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return { ...fixture, launcher, admissionRoot, memory, env, entries, start, readWaiter };
}

test('AUTO nonblocking capacity contenders queue on the decision mutex and dispatch in order', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 62914560);
  await mkdir(fixture.admissionRoot, { recursive: true });
  const mutex = spawn('/usr/bin/flock', [`${fixture.admissionRoot}/lock`, '/bin/sh', '-c', 'printf ready; read release']);
  let ready = '';
  mutex.stdout.on('data', value => { ready += value; });
  const mutexExited = new Promise(resolve => mutex.once('exit', resolve));
  t.after(async () => { mutex.stdin.end('release\n'); await mutexExited; });
  await waitForJointAdmission(() => ready === 'ready', mutex, () => ready);
  const attempts = fixture.path('mutex-attempts');
  writeFakeBin({ root: fixture.root, name: 'flock', content: `#!/bin/sh
if [ "$1" != -u ]; then printf '%s\\n' "$PPID" >> '${attempts}'; fi
exec /usr/bin/flock "$@"
` });
  const order = fixture.path('dispatch-order');
  const runs = [];
  for (let index = 0; index < 6; index++) {
    const run = fixture.start(null, ['/bin/sh', '-c', 'printf "%s\\n" "$1" >> "$2"', 'payload', String(index), order], 'package-dist', ['--no-wait']);
    runs.push(run);
    await waitForJointAdmission(async () => {
      try { return (await readFile(attempts, 'utf8')).trim().split('\n').length >= index + 1; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, run.child, run.stderr);
  }
  assert.ok(runs.every(run => run.child.exitCode === null), runs.map(run => run.stderr()).join('\n'));
  assert.equal((await fixture.entries('waiters')).length, runs.length);
  mutex.stdin.end('release\n');
  await mutexExited;
  for (const run of runs) assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  assert.equal(await readFile(order, 'utf8'), '0\n1\n2\n3\n4\n5\n');
  assert.deepEqual(await fixture.entries('owners'), []);
  assert.deepEqual(await fixture.entries('waiters'), []);
});

test('terminal owner residue does not count as active admission custody', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 1);
  const run = fixture.start(null);
  await waitForJointAdmission(() => run.stderr().includes('waiting for heavyweight admission'), run.child, run.stderr);
  const dead = `${fixture.admissionRoot}/owners/2147483647-1`;
  await mkdir(dead);
  await writeFile(`${dead}/process`, '2147483647 1\n');
  await writeFile(`${dead}/class`, 'package-dist\n');
  // An unknown neighbor prevents the existing narrow reaper's rmdir. It must
  // be preserved without treating the terminal process as an active workload.
  await writeFile(`${dead}/retained`, 'neighbor');
  await writeFile(fixture.memory, '9437184 73400320\n');
  assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  assert.match(run.stderr(), /admitted heavyweight command.*active=1,/);
  assert.equal(await readFile(`${dead}/retained`, 'utf8'), 'neighbor');
});

test('real mixed publisher/plain contention uses one custody worker and drains on release', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 9437184, { realRetry: true });
  const launches = fixture.path('node-launches');
  const cpu = fixture.path('waiter-cpu');
  const probe = fixture.path('cpu.cjs');
  await writeFile(probe, `const fs = require('node:fs');
if (process.argv[1]?.endsWith('workspace_build_admission.mjs') && process.argv[3] !== '[]') {
  const started = process.cpuUsage();
  const sample = () => fs.appendFileSync(${JSON.stringify(cpu)}, JSON.stringify({pid:process.pid, ...process.cpuUsage(started)}) + '\\n');
  process.on('exit', sample);
  const timer = setInterval(sample, 250); timer.unref();
}
`);
  fixture.env.NODE_OPTIONS = `${fixture.env.NODE_OPTIONS || ''} --require=${probe}`;
  const realNode = process.execPath;
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
case "$1:$3" in */workspace_build_admission.mjs:[] | */workspace_build_admission.mjs:--*) ;; */workspace_build_admission.mjs:*) printf 'lease-worker\\n' >> '${launches}' ;; esac
exec '${realNode}' "$@"
` });
  const lockPath = fixture.path('package.lock');
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolve => { release = resolve; }); }, { lockPath });
  await ready;
  const head = fixture.start([{ path: lockPath }]);
  try {
    await waitForJointAdmission(() => head.stderr().includes('workspace-lease-busy'), head.child, head.stderr);
    const first = (await fixture.entries('waiters'))[0];
    const identity = fixture.readWaiter(first).split(' ').slice(0, 3);
    const plain = fixture.start(null);
    assert.deepEqual(await plain.exited, { status: 0, signal: null }, plain.stderr());
    await new Promise(resolve => setTimeout(resolve, 3_500));
    const workerCount = (await readFile(launches, 'utf8')).trim().split('\n').length;
    t.diagnostic(`waiter lease-worker starts over 3.5s: ${workerCount}`);
    const samples = (await readFile(cpu, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const latest = new Map(samples.map(sample => [sample.pid, sample]));
    t.diagnostic(`waiter lease-worker CPU: ${Math.round([...latest.values()].reduce((sum, sample) => sum + sample.user + sample.system, 0) / 1000)}ms`);
    assert.deepEqual(fixture.readWaiter(first).split(' ').slice(0, 3), identity);
    const releasedAt = performance.now();
    release(); await holder;
    const outcome = await Promise.race([head.exited, new Promise(resolve => setTimeout(() => resolve('retry-sleep delay'), 1_000))]);
    t.diagnostic(`release-to-exit: ${Math.round(performance.now() - releasedAt)}ms`);
    assert.deepEqual(outcome, { status: 0, signal: null }, head.stderr());
    assert.equal(workerCount, 1, 'publisher retries must reuse its custody worker');
    assert.equal(head.stdout(), 'payload');
    assert.deepEqual(await fixture.entries('waiters'), []);
    assert.deepEqual(await fixture.entries('owners'), []);
  } finally { release(); await holder; }
});

test('joint workspace admission does not reserve capacity while a foreign dist lease is held', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t);
  const lockPath = fixture.path('package.lock');
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const holder = withWorkspaceBundleLock(async () => {
    entered();
    await new Promise(resolve => { release = resolve; });
  }, { lockPath });
  await ready;
  const run = fixture.start([{ path: lockPath }]);
  try {
    await waitForJointAdmission(async () => (await fixture.entries('waiters')).length === 1, run.child, run.stderr);
    await waitForJointAdmission(() => run.stderr().includes(lockPath), run.child, run.stderr);
    assert.deepEqual(await fixture.entries('owners'), []);
    assert.equal(run.stdout(), '');
    release();
    await holder;
    assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
    assert.equal(run.stdout(), 'payload');
    assert.deepEqual(await fixture.entries('owners'), []);
  } finally { release(); await holder; }
});

test('joint workspace admission releases dist leases before waiting for capacity and preserves its waiter', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 1);
  const lockPath = fixture.path('package.lock');
  const run = fixture.start([{ path: lockPath }]);
  await waitForJointAdmission(() => run.stderr().includes('waiting for heavyweight admission'), run.child, run.stderr);
  const [waiter] = await fixture.entries('waiters');
  assert.ok(waiter);
  const firstWaiter = fixture.readWaiter(waiter).split(' ').slice(0, 3);
  assert.deepEqual(await fixture.entries('owners'), []);
  await withWorkspaceBundleLock(async () => {
    assert.deepEqual(fixture.readWaiter(waiter).split(' ').slice(0, 3), firstWaiter);
    assert.equal(run.stdout(), '');
    await writeFile(fixture.memory, '9437184 73400320\n');
  }, { lockPath });
  assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  assert.equal(run.stdout(), 'payload');
});

test('cancelling joint workspace preparation releases its acquired lease and waiter', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t);
  const first = fixture.path('bundle.lock');
  const second = fixture.path('package.lock');
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolve => { release = resolve; }); }, { lockPath: second });
  await ready;
  const run = fixture.start([{ path: first }, { path: second }]);
  try {
    await waitForJointAdmission(() => run.stderr().includes('workspace-lease-busy'), run.child, run.stderr);
    run.child.kill('SIGTERM');
    assert.deepEqual(await run.exited, { status: 130, signal: null }, run.stderr());
    await assert.rejects(access(first), { code: 'ENOENT' });
    assert.deepEqual(await fixture.entries('waiters'), []);
    assert.deepEqual(await fixture.entries('owners'), []);
    await access(second);
  } finally { release(); await holder; }
});

test('joint workspace admission queues on the native decision mutex before acquiring leases', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t);
  const observed = fixture.path('flock-attempt');
  writeFakeBin({ root: fixture.root, name: 'flock', content: `#!/bin/sh
printf '%s\\n' "$*" >> '${observed}'
exec /usr/bin/flock "$@"
` });
  await mkdir(fixture.admissionRoot, { recursive: true });
  const holder = spawn('/usr/bin/flock', [`${fixture.admissionRoot}/lock`, '/bin/sh', '-c', 'printf ready; read release']);
  let ready = '';
  holder.stdout.on('data', value => { ready += value; });
  const holderExited = new Promise(resolve => holder.once('exit', resolve));
  t.after(async () => { holder.stdin.end('release\n'); await holderExited; });
  await waitForJointAdmission(() => ready === 'ready', holder, () => ready);
  const lockPath = fixture.path('package.lock');
  const run = fixture.start([{ path: lockPath }]);
  await waitForJointAdmission(async () => { try { await access(observed); return true; } catch { return false; } }, run.child, run.stderr);
  assert.equal((await readFile(observed, 'utf8')).split('\n')[0], '9', 'workspace and plain contenders must join the same blocking kernel queue');
  await assert.rejects(access(lockPath), { code: 'ENOENT' });
  await withWorkspaceBundleLock(async () => {
    assert.deepEqual(await fixture.entries('owners'), []);
    assert.equal(run.stdout(), '');
    holder.stdin.end('release\n');
    await holderExited;
  }, { lockPath });
  assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  assert.equal(run.stdout(), 'payload');
});

test('a lease-blocked workspace head allows the lease holder to obtain admission', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t);
  const lockPath = fixture.path('package.lock');
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolve => { release = resolve; }); }, { lockPath });
  await ready;
  const head = fixture.start([{ path: lockPath }]);
  try {
    await waitForJointAdmission(() => head.stderr().includes(lockPath), head.child, head.stderr);
    const [name] = await fixture.entries('waiters');
    const identity = fixture.readWaiter(name).split(' ').slice(0,3);
    assert.equal(identity[0], String(head.child.pid));
    assert.equal(name, `${identity[0]}-${identity[1]}`);
    const successor = fixture.start(null);
    await waitForJointAdmission(() => successor.stdout() === 'payload', successor.child, successor.stderr);
    assert.deepEqual(await successor.exited, { status: 0, signal: null }, successor.stderr());
    assert.deepEqual(fixture.readWaiter(name).split(' ').slice(0,3), identity);
    assert.equal(head.stdout(), '');
    release(); await holder;
    assert.deepEqual(await head.exited, { status: 0, signal: null }, head.stderr());
    assert.equal(head.stdout(), 'payload');
  } finally { release(); await holder; }
});

test('a workspace head admits promptly under contention from many plain contenders', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 31457280);
  await mkdir(fixture.admissionRoot, { recursive: true });
  const holder = spawn('/usr/bin/flock', [`${fixture.admissionRoot}/lock`, '/bin/sh', '-c', 'printf ready; read release']);
  let ready = '';
  holder.stdout.on('data', value => { ready += value; });
  const holderExited = new Promise(resolve => holder.once('exit', resolve));
  t.after(async () => { holder.stdin.end('release\n'); await holderExited; });
  await waitForJointAdmission(() => ready === 'ready', holder, () => ready);
  const head = fixture.start([{ path: fixture.path('package.lock') }], ['/bin/sh', '-c', 'printf head; read release'], 'source-bundle');
  await waitForJointAdmission(async () => (await fixture.entries('waiters')).length === 1, head.child, head.stderr);
  // Pin the OS-clock boundary to establish an unambiguous oldest waiter even
  // when all contenders register during the same wall-clock second.
  const [name] = await fixture.entries('waiters');
  const path = `${fixture.admissionRoot}/waiters/${name}`;
  const fields = (await readFile(path, 'utf8')).trim().split(' ');
  fields[2] = '1';
  await writeFile(path, fields.join(' ') + '\n');
  const contenders = Array.from({ length: 24 }, () => fixture.start(null));
  await waitForJointAdmission(async () => (await fixture.entries('waiters')).length === 25, head.child, head.stderr);
  holder.stdin.end('release\n'); await holderExited;
  await waitForJointAdmission(() => head.stdout() === 'head', head.child, () => head.stderr() + contenders.map(run => run.stderr()).join('\n'));
  assert.equal((await fixture.entries('owners')).length > 0, true);
  head.child.stdin.end('release\n');
  assert.deepEqual(await head.exited, { status: 0, signal: null }, head.stderr());
  for (const run of contenders) assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  assert.deepEqual(await fixture.entries('waiters'), []);
});

test('joint workspace preparation rejects a foreign lease without charging an admitted ancestor lock wait or disturbing its sibling', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t);
  const lockPath = fixture.path('package.lock');
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolve => { release = resolve; }); }, { lockPath });
  await ready;
  const script = fixture.path('parent.mjs');
  const ownerFile = fixture.path('owner.json');
  const completedFile = fixture.path('completed');
  await writeFile(script, `import { spawn } from 'node:child_process';
import { writeJsonAtomic } from ${JSON.stringify(new URL('./utils/fs/json.mjs', import.meta.url).href)};
import { once } from 'node:events';
const [launcher, lock, ownerFile, completedFile] = process.argv.slice(2);
const ownerPath = process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT + '/owners/' + process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN.replace(':', '-');
await writeJsonAtomic(ownerFile, { ownerPath });
await once(process.stdin, 'data');
const sibling = spawn('/bin/sh', ['-c', 'printf ready; read release']);
await once(sibling.stdout, 'data');
const siblingExit = once(sibling, 'exit');
const nested = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=compilation', '--machine=worker', '--workspace-locks=' + JSON.stringify([{ path: lock }]), '--', '/bin/sh', '-c', 'printf nested'], { stdio: ['ignore', 'pipe', 'inherit'] });
let output = '';
nested.stdout.on('data', chunk => { output += chunk; });
const [status] = await once(nested, 'exit');
await writeJsonAtomic(completedFile, {status,output,siblingStatus:sibling.exitCode});
await once(process.stdin, 'data');
sibling.stdin.end('release\\n');
await siblingExit;
`);
  const parent = spawn('/bin/sh', [fixture.launcher, '--heavyweight-admission', '--class=validation', '--machine=worker', '--',
    process.execPath, script, fixture.launcher, lockPath, ownerFile, completedFile], { env: fixture.env });
  let stderr = '';
  parent.stderr.on('data', value => { stderr += value; });
  const exited = new Promise(resolve => parent.once('exit', (status, signal) => resolve({ status, signal })));
  t.after(async () => { if (parent.exitCode === null) parent.kill('SIGTERM'); await exited; });
  try {
    await waitForJointAdmission(async () => { try { await access(ownerFile); return true; } catch { return false; } }, parent, () => stderr);
    const { ownerPath } = JSON.parse(await readFile(ownerFile, 'utf8'));
    parent.stdin.write('start\n');
    // A prior implementation starts waiting on the foreign lock while the
    // ancestor's envelope remains charged. Drain that incorrect path for RED,
    // but retain its observable successful payload as the counterexample.
    await waitForJointAdmission(async () => {
      try { await access(completedFile); return true; } catch {}
      try { await access(`${lockPath}.priority-claim`); return true; } catch { return false; }
    }, parent, () => stderr);
    let improperlyWaited = false;
    try { await access(completedFile); } catch { improperlyWaited = true; }
    if (improperlyWaited) {
      await writeFile(fixture.memory, '31457280 73400320\n');
      release();
      await holder;
    }
    await waitForJointAdmission(async () => { try { await access(completedFile); return true; } catch { return false; } }, parent, () => stderr);
    assert.deepEqual(JSON.parse(await readFile(completedFile, 'utf8')), {status:1,output:'',siblingStatus:null}, stderr);
    assert.equal(improperlyWaited, false, 'an admitted ancestor cannot wait for a foreign workspace lease');
    assert.match(stderr, /HSTACK_WORKSPACE_ADMISSION_ORDER/);
    assert.equal((await readFile(`${ownerPath}/class`, 'utf8')).trim(), 'validation');
    assert.equal((await fixture.entries('owners')).length, 1);
    await access(lockPath);
    parent.stdin.end('release\n');
    assert.deepEqual(await exited, { status: 0, signal: null }, stderr);
  } finally { release(); await holder; }
});

test('inherited workspace leases reject capacity waiting in both joint and bare admission', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 1);
  const lockPath = fixture.path('package.lock');
  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    for (const workspaceFlags of [[], [`--workspace-locks=${JSON.stringify([{ path: lockPath }])}`]]) {
      const child = spawn('/bin/sh', [fixture.launcher, '--heavyweight-admission', '--class=package-dist', '--machine=worker',
        ...workspaceFlags, '--', '/bin/sh', '-c', 'printf forbidden'], { env: { ...fixture.env,
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue } });
      let stderr = '', stdout = '';
      child.stderr.on('data', value => { stderr += value; });
      child.stdout.on('data', value => { stdout += value; });
      const exited = new Promise(resolve => child.once('exit', (status, signal) => resolve({ status, signal })));
      t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
      assert.deepEqual(await exited, { status: 1, signal: null }, stderr);
      assert.match(stderr, /HSTACK_WORKSPACE_ADMISSION_ORDER/);
      assert.equal(stdout, '');
      assert.deepEqual(await fixture.entries('owners'), []);
      assert.deepEqual(await fixture.entries('waiters'), []);
      await access(lockPath); // The descendant must not release its caller's lease.
    }
  }, { lockPath });
});

for (const joint of [false, true]) test(`inherited dependency readers reject ${joint ? 'joint' : 'bare'} capacity escalation instead of blocking their writer`, { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t);
  fixture.env.HAPPIER_STACK_HOME_DIR = fixture.root;
  const lockPath = resolveDependencyRefreshLockPath(fixture.root, fixture.env);
  const script = fixture.path('nested-reader.mjs');
  await writeFile(script, `import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
const child = spawn('/bin/sh', [${JSON.stringify(fixture.launcher)}, '--heavyweight-admission', '--class=compilation', '--machine=worker',
  ...${JSON.stringify(joint ? [`--workspace-locks=${JSON.stringify([{ path: fixture.path('nested.lock') }])}`] : [])}, '--', process.execPath, '-e', 'process.stdout.write("forbidden")'], {stdio:['ignore','pipe','inherit']});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
const [status] = await once(child, 'exit');
const ownerPath = process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT + '/owners/' + process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN.replace(':', '-');
console.log(JSON.stringify({status, output, ownerClass:(await readFile(ownerPath + '/class', 'utf8')).trim()}));
`);
  const run = fixture.start([{ kind: 'dependency', installDir: fixture.root, path: lockPath }], [process.execPath, script], 'validation');
  await waitForJointAdmission(() => run.stdout().includes('ownerClass') || run.stderr().includes('inherited owner'), run.child, run.stderr);
  const waited = !run.stdout().includes('ownerClass');
  // Drain the incorrect escalation for a deciding assertion, retaining the
  // containing reader until the child returns rather than timing out the test.
  if (waited) await writeFile(fixture.memory, '31457280 73400320\n');
  assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  assert.equal(waited, false, 'capacity waiting while retaining a dependency reader blocks the installer needed by its peers');
  assert.deepEqual(JSON.parse(run.stdout()), { status: 1, output: '', ownerClass: 'validation' });
  assert.match(run.stderr(), /HSTACK_WORKSPACE_ADMISSION_ORDER/);
  assert.deepEqual(await fixture.entries('owners'), []);
  assert.deepEqual(await fixture.entries('waiters'), []);
  await assert.rejects(access(lockPath), { code: 'ENOENT' });
});

test('joint workspace same-class inherited reentry does not wait for the native decision mutex', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t);
  const lockPath = fixture.path('package.lock');
  const script = fixture.path('same-class.mjs');
  await writeFile(script, `import { spawn } from 'node:child_process';
import { once } from 'node:events';
const [launcher, admissionRoot, lockPath] = process.argv.slice(2);
const mutex = spawn('/usr/bin/flock', [admissionRoot + '/lock', '/bin/sh', '-c', 'printf ready; read release']);
await once(mutex.stdout, 'data');
const mutexExit = once(mutex, 'exit');
const child = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=package-dist', '--machine=worker', '--workspace-locks=' + JSON.stringify([{path:lockPath}]), '--', '/bin/sh', '-c', 'printf nested'], {stdio:['ignore','inherit','inherit']});
const [status] = await once(child, 'exit');
if (status !== 0) throw new Error('same-class child failed ' + status);
mutex.stdin.end('release\\n');
await mutexExit;
`);
  const run = fixture.start([{ path: lockPath }], [process.execPath, script, fixture.launcher, fixture.admissionRoot, lockPath]);
  assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  assert.equal(run.stdout(), 'nested');
  assert.deepEqual(await fixture.entries('owners'), []);
  assert.deepEqual(await fixture.entries('waiters'), []);
});

for (const mode of ['covered', 'upgrade', 'lost-context']) test(`competing admitted parents make nested progress without another capacity wait (${mode})`, { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  // Both containing jobs fit. An undeclared UI upgrade, or a second install
  // reservation after a lifecycle boundary loses context, does not fit.
  const fixture = await createJointAdmissionFixture(t, (mode === 'upgrade' ? 24 : 27) * 1024 * 1024);
  const script = fixture.path('competing-parents.mjs');
  await writeFile(script, `import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readdir,readFile} from 'node:fs/promises';
const [launcher,requested,drop] = process.argv.slice(2);
const env = {...process.env};
if(drop==='yes') for(const key of Object.keys(env)) if(key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')) delete env[key];
process.stdout.write('ready\\n');
await once(process.stdin,'data');
const child=spawn('/bin/sh',[launcher,'--heavyweight-admission','--class='+requested,'--machine=worker','--',process.execPath,'-e','process.stdout.write("nested")'],{env,stdio:['ignore','pipe','inherit']});
let output='';child.stdout.on('data',value=>output+=value);
const [status]=await once(child,'exit');
const root=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT;
const identity=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN.replace(':','-');
process.stdout.write(JSON.stringify({status,output,owners:(await readdir(root+'/owners')).length,waiters:(await readdir(root+'/waiters')).length,ownerClass:(await readFile(root+'/owners/'+identity+'/class','utf8')).trim()})+'\\n');
await once(process.stdin,'data');
`);
  const compilerClass = mode === 'upgrade' ? 'compilation-cli' : 'compilation-ui';
  const parents = [
    fixture.start(null, [process.execPath, script, fixture.launcher, 'compilation-ui', 'no'], compilerClass),
    fixture.start(null, [process.execPath, script, fixture.launcher, 'validation', mode === 'lost-context' ? 'yes' : 'no'], 'dependency-install'),
  ];
  for (const run of parents) await waitForJointAdmission(() => run.stdout().includes('ready'), run.child, run.stderr);
  assert.equal((await fixture.entries('owners')).length, 2);
  const initialDiagnostics = parents.map(run => run.stderr().length);
  const nestedDiagnostics = () => parents.map((run, index) => run.stderr().slice(initialDiagnostics[index]));
  for (const run of parents) run.child.stdin.write('start\n');
  await waitForJointAdmission(() => parents.every(run => run.stdout().includes('ownerClass'))
    || nestedDiagnostics().some(value => value.includes('waiting for heavyweight admission')), null,
  () => parents.map(run => run.stderr()).join('\n'));
  const blocked = nestedDiagnostics().some(value => value.includes('waiting for heavyweight admission'));
  // Drain the old implementation for a contract assertion rather than leaving
  // a timeout and orphaned admitted trees as the only RED evidence.
  if (blocked) await writeFile(fixture.memory, '67108864 73400320\n');
  for (const run of parents) await waitForJointAdmission(() => run.stdout().includes('ownerClass'), run.child, run.stderr);
  const results = parents.map(run => JSON.parse(run.stdout().trim().split('\n').at(-1)));
  for (const run of parents) run.child.stdin.end('release\n');
  for (const run of parents) assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  assert.equal(blocked, false, 'no descendant may wait for capacity held by the two containing jobs: ' + nestedDiagnostics().join('\n'));
  assert.deepEqual(results, [
    { status: mode === 'upgrade' ? 1 : 0, output: mode === 'upgrade' ? '' : 'nested', owners: 2, waiters: 0, ownerClass: compilerClass },
    { status: 0, output: 'nested', owners: 2, waiters: 0, ownerClass: 'dependency-install' },
  ]);
  assert.deepEqual(await fixture.entries('owners'), []);
  assert.deepEqual(await fixture.entries('waiters'), []);
});

test('joint workspace immediately available escalation preserves its ancestor and running sibling', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createJointAdmissionFixture(t, 31457280);
  const first = fixture.path('bundle.lock');
  const second = fixture.path('package.lock');
  const script = fixture.path('escalation.mjs');
  await writeFile(script, `import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
const [launcher, first, second] = process.argv.slice(2);
const sibling = spawn('/bin/sh', ['-c', 'printf ready; read release']);
await once(sibling.stdout, 'data');
const siblingExit = once(sibling, 'exit');
const child = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=compilation', '--machine=worker', '--workspace-locks=' + JSON.stringify([{path:first},{path:second}]), '--', '/usr/bin/true'], {stdio:['ignore','ignore','inherit']});
const [status] = await once(child, 'exit');
const root = process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT;
const identity = process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN.replace(':','-');
process.stdout.write(JSON.stringify({status,class:(await readFile(root+'/owners/'+identity+'/class','utf8')).trim(),owners:(await readdir(root+'/owners')).length,siblingStatus:sibling.exitCode}));
sibling.stdin.end('release\\n');
await siblingExit;
`);
  const run = fixture.start([{ path: first }], [process.execPath, script, fixture.launcher, first, second]);
  assert.deepEqual(await run.exited, { status: 0, signal: null }, run.stderr());
  assert.deepEqual(JSON.parse(run.stdout()), { status: 0, class: 'compilation', owners: 1, siblingStatus: null });
  assert.deepEqual(await fixture.entries('owners'), []);
  await assert.rejects(access(first), { code: 'ENOENT' });
  await assert.rejects(access(second), { code: 'ENOENT' });
});

for (const mode of ['async', 'sync']) {
  test(`admitted lock-only ${mode} workspace consumers reject a foreign dist lease before waiting`, { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
    const fixture = await createJointAdmissionFixture(t);
    const lockPath = fixture.path('bundle.lock');
    const script = fixture.path('lock-only.mjs');
    await writeFile(script, `import {withWorkspaceBundleLock,withWorkspaceBundleLockSync} from ${JSON.stringify(new URL('../../../packages/cli-common/workspaceBundleLock.mjs', import.meta.url).href)};
const [lockPath,mode]=process.argv.slice(2);
try {
  const take=mode==='sync'?withWorkspaceBundleLockSync:withWorkspaceBundleLock;
  await take(()=>process.stdout.write('forbidden'),{lockPath});
} catch(error) {
  process.stderr.write(String(error.code)+' '+error.message);
  process.exitCode=1;
}
`);
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const holder = withWorkspaceBundleLock(async () => { entered(); await new Promise(resolve => { release = resolve; }); }, { lockPath });
    await ready;
    const run = fixture.start([], [process.execPath, script, lockPath, mode]);
    try {
      await waitForJointAdmission(async () => {
        if (run.child.exitCode !== null) return true;
        try { await access(`${lockPath}.priority-claim`); return true; } catch { return false; }
      }, null, run.stderr);
      if (run.child.exitCode === null) { release(); await holder; }
      assert.deepEqual(await run.exited, { status: 1, signal: null }, run.stderr());
      assert.equal(run.stdout(), '');
      assert.match(run.stderr(), /EWORKSPACEBUNDLELOCKBUSY/);
      assert.match(run.stderr(), /HSTACK_WORKSPACE_ADMISSION_ORDER/);
    } finally { release(); await holder; }
  });
}

test('an old-format head cannot block current admission, whose head identity survives a renamed record', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-admission-version-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root });
  // Remap only /tmp, retaining the production protocol revision in the path.
  const state = await readFile(new URL('./utils/proc/native_host_admission_state.sh', import.meta.url), 'utf8');
  await writeFile(fixture.path('native-owner/apps/stack/scripts/utils/proc/native_host_admission_state.sh'),
    state.replace("'/tmp/", `'${fixture.root.replaceAll("'", "'\\''")}/`));
  const oldRoot = fixture.path('happier-heavyweight-admission-v1');
  const currentRoot = fixture.path('happier-heavyweight-admission-v3');
  const token = readProcessInstanceFingerprintSync(process.pid).slice('linux-proc:'.length);
  const oldHead = `${oldRoot}/waiters/${process.pid}-${token}`;
  await mkdir(`${oldRoot}/waiters`, { recursive: true });
  await writeFile(oldHead, `${process.pid} ${token} 1\n`);
  const priorHead = fixture.path(`happier-heavyweight-admission-v2/waiters/${process.pid}-${token}`);
  await mkdir(fixture.path('happier-heavyweight-admission-v2/waiters'), { recursive: true });
  await writeFile(priorHead, `${process.pid} ${token} 1 source-bundle 0\n`);
  // The memory-observation OS boundary renames the current waiter's file
  // between the two real queue decisions; pid + kernel token stay unchanged.
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*)
    for waiter in "$FIXTURE_CURRENT_ROOT/waiters/"*; do
      [ -f "$waiter" ] || continue
      mv -- "$waiter" "$FIXTURE_CURRENT_ROOT/waiters/head"
    done
    printf '9437184 20971520\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait', '--class=validation',
    '--machine=worker', '--', '/bin/sh', '-c', 'printf "%s" "$HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT"'], {
    encoding: 'utf8', env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_CURRENT_ROOT: currentRoot,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, currentRoot);
  assert.equal(await readFile(oldHead, 'utf8'), `${process.pid} ${token} 1\n`);
  assert.equal(await readFile(priorHead, 'utf8'), `${process.pid} ${token} 1 source-bundle 0\n`);
});

test('queued equal-or-larger classes do not observe resources before the live FIFO head', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-admission-head-observation-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const token = readProcessInstanceFingerprintSync(process.pid).slice('linux-proc:'.length);
  await mkdir(`${admissionRoot}/waiters`, { recursive: true });
  await writeFile(`${admissionRoot}/waiters/${process.pid}-${token}`, `${process.pid} ${token} 1 validation 0\n`);
  // Node is the resource observer's OS-process boundary, not queue logic.
  const marker = fixture.path('observed');
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
printf observed >> "$FIXTURE_OBSERVED"
printf 'service 0\\n'
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_OBSERVED: marker,
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  for (let queued = 0; queued < 40; queued++) {
    const check = queued % 4 < 2;
    const result = spawnSync('/bin/sh', [launcher, check ? '--heavyweight-admission-check' : '--heavyweight-admission',
      ...(!check ? ['--no-wait'] : []), `--class=${queued % 2 ? 'compilation' : 'validation'}`, '--machine=worker',
      ...(!check ? ['--', '/usr/bin/true'] : [])], { env, encoding: 'utf8' });
    assert.equal(result.status, check ? 1 : 75, result.stderr);
  }
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('a no-wait capacity contender remains cancellable while queued on the decision mutex', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-admission-kernel-wait-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  await mkdir(admissionRoot, { recursive: true });
  const ready = fixture.path('locked'), polling = fixture.path('polled');
  const holder = spawn('/usr/bin/flock', [`${admissionRoot}/lock`, '/bin/sh', '-c', 'touch "$1"; read -r release', 'hold', ready]);
  const holderExited = new Promise(resolve => holder.once('exit', resolve));
  let child, childExited;
  t.after(async () => {
    holder.stdin.end('release\n');
    if (child?.exitCode === null) child.kill('SIGTERM');
    await Promise.all([holderExited, childExited]);
  });
  for (let attempt = 0; ; attempt++) {
    try { await access(ready); break; } catch (error) {
      if (error.code !== 'ENOENT' || attempt === 250) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  // Sleep is an OS boundary: observing it here proves the former busy-lock
  // retry path, not a product admission-pressure wait after a real decision.
  writeFakeBin({ root: fixture.root, name: 'sleep', content: '#!/bin/sh\ntouch "$FIXTURE_POLLING"\nexec /bin/sleep "$@"\n' });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  child = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait', '--class=validation', '--machine=worker', '--', '/usr/bin/true'], {
    env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_POLLING: polling,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  childExited = new Promise(resolve => child.once('exit', resolve));
  let kernelWait = false;
  for (let attempt = 0; attempt < 250; attempt++) {
    const children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    for (const pid of children) {
      try { if ((await readFile(`/proc/${pid}/wchan`, 'utf8')).includes('locks_lock')) kernelWait = true; } catch {}
    }
    if (kernelWait) break;
    try { await access(polling); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(kernelWait, true, 'contended decision should sleep on the existing kernel lock, not retry processes');
  await assert.rejects(access(polling), { code: 'ENOENT' });
  // Cancel while the decision lock is still held. The wrapper owns its
  // blocking flock child just as it owns the eventual payload child.
  child.kill('SIGTERM');
  assert.equal(await childExited, 130);
  child = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait', '--class=validation', '--machine=worker', '--', '/usr/bin/true'], {
    env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_POLLING: polling,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  childExited = new Promise(resolve => child.once('exit', resolve));
  holder.stdin.end('release\n');
  assert.equal(await childExited, 0);
});

test('nested package admission preserves its live parent and ignores incomplete retired owner records', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-global-nested-package-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  await mkdir(`${admissionRoot}/owners/99999999-1`, { recursive: true });
  await writeFile(`${admissionRoot}/owners/99999999-1/disk`, 'retired field\n');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '9437184 26676708\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const sanitizedChild = fixture.path('sanitized-child.mjs');
  await writeFile(sanitizedChild, `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sanitizeStackTestRunnerEnv } from ${JSON.stringify(new URL('./utils/test/test_env.mjs', import.meta.url).href)};
const child = spawnSync('/bin/sh', [process.argv[2], '--heavyweight-admission', '--class=package-dist', '--machine=worker', '--no-wait', '--', '/usr/bin/true'], { encoding: 'utf8', env: sanitizeStackTestRunnerEnv(process.env) });
assert.equal(child.status, 0, child.stderr);
`);
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--machine=worker', '--no-wait', '--',
    '/bin/sh', '-eu', '-c', `
    owner="$HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT/owners/$(printf '%s' "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN" | tr : -)"
    before=$(cat "$owner/process")
    "$1" --heavyweight-admission --class=package-dist --machine=worker --no-wait -- /usr/bin/true
    "$3" "$4" "$1"
    [ "$before" = "$(cat "$owner/process")" ]
    printf '%s' "$before" > "$2"
    `, 'nested-package', launcher, fixture.path('parent'), process.execPath, sanitizedChild], {
    encoding: 'utf8', env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(fixture.path('parent'), 'utf8'), /^[0-9]+ [0-9]+$/);
  assert.doesNotMatch(result.stderr, /cannot open|insufficient memory|inherited owner/);
});

test('private mirrors, caller roots and machine aliases share the worker host admission', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-global-admission-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const started = fixture.path('started');
  const release = fixture.path('release');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '9437184 20971520\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const privateOne = fixture.path('private-one');
  const privateTwo = fixture.path('private-two');
  const owner = spawn('/bin/sh', [launcher, '--heavyweight-admission', `--admission-root=${privateOne}`,
    '--class=validation', '--machine=private-alias-one', '--', '/bin/sh', '-c',
    'touch "$1"; while [ ! -e "$2" ]; do sleep 0.02; done', 'owner', started, release], {
    env: { ...env, HOME: privateOne, HAPPIER_STACK_CLI_HOME_DIR: privateOne, TMPDIR: privateOne },
  });
  let stderr = '';
  owner.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => owner.once('exit', resolve));
  try {
    for (let attempt = 0; ; attempt++) {
      try { await access(started); break; } catch (error) {
        if (error.code !== 'ENOENT' || attempt === 250 || owner.exitCode !== null) throw new Error(`owner failed to start: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const second = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait',
      `--admission-root=${privateTwo}`, '--class=validation', '--machine=private-alias-two', '--', '/bin/sh', '-c', 'exit 42'], {
      env: { ...env, HOME: privateTwo, HAPPIER_STACK_CLI_HOME_DIR: privateTwo, HAPPIER_HOME_DIR: privateTwo, TMPDIR: privateTwo }, encoding: 'utf8',
    });
    assert.equal(second.status, 75, second.stderr);
    assert.match(second.stderr, /reserved-memory=6291456|heavyweight admission declined before dispatch/);
    await access(admissionRoot);
    await assert.rejects(access(privateOne), { code: 'ENOENT' });
    await assert.rejects(access(privateTwo), { code: 'ENOENT' });
    await writeFile(release, '');
    assert.equal(await exited, 0, stderr);
    const afterExit = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait',
      `--admission-root=${privateTwo}`, '--class=validation', '--machine=private-alias-two', '--', '/usr/bin/true'], { env, encoding: 'utf8' });
    assert.equal(afterExit.status, 0, afterExit.stderr);
  } finally {
    await writeFile(release, '');
    if (owner.exitCode === null) owner.kill('SIGTERM');
    await exited;
  }
});

test('a live legacy private-root parent migrates its existing envelope instead of reserving a second job', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-global-legacy-parent-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const legacyRoot = fixture.path('legacy');
  const fingerprint = readProcessInstanceFingerprintSync(process.pid);
  assert.match(fingerprint, /^linux-proc:[0-9]+$/);
  const token = fingerprint.slice('linux-proc:'.length);
  const owner = `${legacyRoot}/owners/${process.pid}-${token}`;
  await mkdir(owner, { recursive: true });
  await writeFile(`${owner}/process`, `${process.pid} ${token}\n`);
  await writeFile(`${owner}/class`, 'validation\n');
  await writeFile(`${owner}/machine`, 'old-private-alias\n');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '9437184 20971520\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait', '--class=validation',
    '--machine=new-worker-alias', '--', '/bin/sh', '-c',
    'printf "%s|%s\\n" "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN" "$HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT"'], {
    encoding: 'utf8', env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: `${process.pid}:${token}`,
      HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: legacyRoot, HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: 'old-private-alias' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${process.pid}:${token}|${admissionRoot}\n`);
  await access(`${admissionRoot}/owners/${process.pid}-${token}/class`);
});

for (const entry of ['bare', 'joint']) {
  test(`${entry} legacy private-root adoption refuses mutex waiting while its ancestor holds a dist lease`, { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
    const fixture = await createJointAdmissionFixture(t);
    const legacyRoot = fixture.path('legacy');
    const token = readProcessInstanceFingerprintSync(process.pid).slice('linux-proc:'.length);
    const owner = `${legacyRoot}/owners/${process.pid}-${token}`;
    await mkdir(owner, { recursive: true });
    await writeFile(`${owner}/process`, `${process.pid} ${token}\n`);
    await writeFile(`${owner}/class`, 'package-dist\n');
    await writeFile(`${owner}/machine`, 'old-private-alias\n');
    const before = await readFile(`${owner}/process`, 'utf8');
    const attempted = fixture.path('flock-attempt');
    // Observe the genuine kernel mutex invocation. The old blocking path is
    // drained after observation, so RED never strands the fixture ancestor.
    writeFakeBin({ root: fixture.root, name: 'flock', content: `#!/bin/sh
if [ "$1" != -u ]; then printf '%s' "$*" > "$FIXTURE_FLOCK_ATTEMPT"; fi
exec /usr/bin/flock "$@"
` });
    await mkdir(fixture.admissionRoot, { recursive: true });
    const mutex = spawn('/usr/bin/flock', [`${fixture.admissionRoot}/lock`, '/bin/sh', '-c', 'printf ready; read release']);
    let ready = '';
    mutex.stdout.on('data', value => { ready += value; });
    const mutexExited = new Promise(resolve => mutex.once('exit', resolve));
    t.after(async () => { mutex.stdin.end('release\n'); await mutexExited; });
    await waitForJointAdmission(() => ready === 'ready', mutex, () => ready);
    const lockPath = fixture.path('bundle.lock');
    await withWorkspaceBundleLock(async ({ heldLockValue }) => {
      const child = spawn('/bin/sh', [fixture.launcher, '--heavyweight-admission', '--class=package-dist', '--machine=worker',
        ...(entry === 'joint' ? [`--workspace-locks=${JSON.stringify([{ path: lockPath }])}`] : []),
        '--', '/bin/sh', '-c', 'printf forbidden'], { env: { ...fixture.env,
          FIXTURE_FLOCK_ATTEMPT: attempted, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
          HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: `${process.pid}:${token}`,
          HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: legacyRoot, HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: 'old-private-alias' } });
      let stdout = '', stderr = '';
      child.stdout.on('data', value => { stdout += value; });
      child.stderr.on('data', value => { stderr += value; });
      const exited = new Promise(resolve => child.once('exit', (status, signal) => resolve({ status, signal })));
      t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
      await waitForJointAdmission(async () => { try { await access(attempted); return true; } catch { return false; } }, child, () => stderr);
      if ((await readFile(attempted, 'utf8')) === '9') {
        mutex.stdin.end('release\n');
        await mutexExited;
      }
      assert.deepEqual(await exited, { status: 1, signal: null }, stderr);
      assert.match(stderr, /HSTACK_WORKSPACE_ADMISSION_ORDER/);
      assert.equal(stdout, '');
      assert.equal(await readFile(`${owner}/process`, 'utf8'), before);
      assert.equal((await readFile(`${owner}/class`, 'utf8')).trim(), 'package-dist');
      assert.deepEqual(await fixture.entries('owners'), []);
      await access(lockPath);
    }, { lockPath });
  });
}

test('a different execution account cannot replace an unavailable host authority with private admission', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-global-account-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root });
  // Ownership is an OS boundary. This fixture models a host state directory
  // owned by another execution account without changing actual OS identities.
  writeFakeBin({ root: fixture.root, name: 'stat', content: `#!/bin/sh
if [ "$1" = -c ] && [ "$2" = %u ]; then printf '${process.getuid() + 1}\\n'; else exec /usr/bin/stat "$@"; fi
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const privateRoot = fixture.path('private');
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait',
    `--admission-root=${privateRoot}`, '--class=validation', '--machine=other-account', '--', '/usr/bin/true'], {
    encoding: 'utf8', env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /host-global.*unavailable/);
  await assert.rejects(access(privateRoot), { code: 'ENOENT' });
});

test('native non-Linux execution preserves its existing path without resolving Linux host state', async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-admission-non-linux-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  writeFakeBin({ root: fixture.root, name: 'uname', content: '#!/bin/sh\nprintf "Darwin\\n"\n' });
  writeFakeBin({ root: fixture.root, name: 'stat', content: '#!/bin/sh\nexit 1\n' });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--', '/bin/sh', '-c', 'exit 42'], {
    encoding: 'utf8', env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 42, result.stderr);
  await assert.rejects(access(admissionRoot), { code: 'ENOENT' });
});
