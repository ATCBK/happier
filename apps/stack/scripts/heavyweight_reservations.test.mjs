import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { readLinuxWorkerProcesses } from './utils/proc/service_memory.mjs';
import { resolveHeavyweightMemoryFloorKiB } from './utils/dev_targets/remote_commands.mjs';

async function waitForAdmissionDecision(child, readStderr) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (readStderr().includes('waiting for heavyweight admission')) return;
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(`waiter exited before deciding: ${readStderr()}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.fail(`waiter did not decide admission: ${readStderr()}`);
}

test('local heavyweight admission protects the browser memory floor without raising worker envelopes', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-local-memory-floor-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root, prepareDependencies: true });
  const memory = fixture.path('memory');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, CI: '',
    FIXTURE_MEMORY: memory, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const run = (machine, check = false, extraEnv = {}) => spawnSync('/bin/sh', [launcher,
    check ? '--heavyweight-admission-check' : '--heavyweight-admission', '--class=validation', `--machine=${machine}`,
    ...(check ? [] : ['--no-wait', '--', '/usr/bin/printf', 'started']),
  ], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  // The controller has 70 GiB total: just below 8 GiB passes both the old
  // 6 GiB validation envelope and the old 10% ratio, but pauses browsers.
  await writeFile(memory, '8388607 73400320\n');
  const blocked = run('local');
  assert.equal(blocked.status, 75, blocked.stderr);
  assert.equal(blocked.stdout, '');
  const check = run('local', true);
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stderr, /requires=8388608 KiB/);
  assert.equal(run('worker').status, 0, 'workers retain the measured class envelope');
  assert.equal(run('local', false, { HAPPIER_DEV_TARGET_EXECUTION: '1' }).status, 0, 'already placed workers retain worker admission');
  await writeFile(memory, '8388608 73400320\n');
  const admitted = run('local');
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(admitted.stdout, 'started');
  const compilation = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', '--class=compilation', '--machine=local'], { env, encoding: 'utf8' });
  assert.equal(compilation.status, 1, compilation.stderr);
  assert.match(compilation.stderr, new RegExp(`requires=${resolveHeavyweightMemoryFloorKiB('compilation')} KiB`));

  // Explicit local execution shares the same gate, waits without starting
  // its payload, and resumes when the observed memory floor is available.
  writeFakeBin({ root: fixture.root, name: 'vitest', content: '#!/bin/sh\nprintf started\n' });
  // Preparation consumes the canonical ready, dependency-free worker tree.
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
exec '${process.execPath}' "$@"
` });
  await writeFile(memory, '8388607 73400320\n');
  const child = spawn('/bin/sh', [launcher, '--local', '--', 'vitest', 'run'], { env });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  try {
    await waitForAdmissionDecision(child, () => stderr);
    assert.match(stderr, /requires=8388608 KiB/);
    assert.equal(stdout, '');
    await writeFile(memory, '8388608 73400320\n');
    assert.equal(await exited, 0, stderr);
    assert.equal(stdout, 'started');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});

test('heavyweight admission backfills fitting work within the blocked head envelope then gives the head capacity priority', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-admission-backfill-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root, admissionRoot: fixture.path('heavyweight-admission-v1') });
  const memory = fixture.path('memory');
  const marker = fixture.path('large-started');
  const headKiB = resolveHeavyweightMemoryFloorKiB('compilation-server');
  const smallKiB = resolveHeavyweightMemoryFloorKiB('validation');
  const availableKiB = smallKiB + Math.floor((headKiB - 2 * smallKiB) / 2);
  const totalKiB = headKiB * 3;
  const setMemory = available => writeFile(memory, `${available} ${totalKiB}\n`);
  await setMemory(availableKiB);
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = {
    ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HOME: fixture.root, HAPPIER_HOME_DIR: fixture.root, HAPPIER_STACK_CLI_HOME_DIR: fixture.root,
    FIXTURE_MEMORY: memory, HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
  };
  const runSmall = (check = false, wait = false) => spawnSync('/bin/sh', [launcher,
        check ? '--heavyweight-admission-check' : '--heavyweight-admission',
        '--class=validation', '--machine=fixture', ...(check ? [] : [...(wait ? [] : ['--no-wait']), '--', '/bin/sh', '-c', 'printf small']),
      ], { env, encoding: 'utf8' });
  let head, headExited, stderr;
  const startHead = async () => {
    stderr = '';
    head = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=compilation-server', '--machine=fixture', '--', '/bin/sh', '-c', 'touch "$1"', 'large', marker], { env });
    head.stderr.on('data', chunk => { stderr += chunk; });
    headExited = new Promise(resolveExit => head.once('exit', resolveExit));
    await waitForAdmissionDecision(head, () => stderr);
    // The waiting diagnostic follows release of the real admission mutex and
    // workspace attempt. Pause only this fixture's live head to control OS
    // scheduling while nonblocking candidates exercise resource decisions.
    head.kill('SIGSTOP');
    while (!/\) T /.test(await readFile(`/proc/${head.pid}/stat`, 'utf8'))) {
      t.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  t.after(async () => {
    if (head && head.exitCode === null && head.signalCode === null) { head.kill('SIGCONT'); head.kill('SIGTERM'); }
    await headExited;
  });
  await startHead();
  await setMemory(smallKiB - 1);
  for (let retry = 0; retry < 4; retry++) {
    const unavailable = await runSmall();
    assert.equal(unavailable.status, 75, unavailable.stderr);
    assert.equal(unavailable.stdout, '');
    assert.match(unavailable.stderr, /memory-available=/);
  }
  await setMemory(availableKiB);
  const firstSmall = await runSmall(false, true);
  assert.equal(firstSmall.status, 0, firstSmall.stderr);
  assert.equal(firstSmall.stdout, 'small');
  // Read-only probing must never spend a head's backfill envelope.
  for (let probe = 0; probe < 5; probe++) {
    const ready = await runSmall(true);
    assert.equal(ready.status, 0, ready.stderr);
  }
  for (let admitted = 1; admitted < Math.floor(headKiB / smallKiB); admitted++) {
    const small = await runSmall();
    assert.equal(small.status, 0, small.stderr);
    assert.equal(small.stdout, 'small');
  }
  const exhausted = await runSmall();
  assert.equal(exhausted.status, 75, exhausted.stderr);
  assert.equal(exhausted.stdout, '');
  assert.match(exhausted.stderr, /head-backfill-envelope-exhausted/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await setMemory(headKiB);
  head.kill('SIGCONT');
  assert.equal(await headExited, 0, stderr);
  await readFile(marker);
  const afterHead = await runSmall();
  assert.equal(afterHead.status, 0, afterHead.stderr);
  // A fresh head has an unused backfill envelope, but approaching its floor
  // already protects enough capacity for it instead of starting another job.
  await setMemory(headKiB - smallKiB);
  await startHead();
  const approaching = await runSmall();
  assert.equal(approaching.status, 75, approaching.stderr);
  assert.equal(approaching.stdout, '');
  assert.match(approaching.stderr, /head-capacity-priority/);
  await setMemory(headKiB);
  head.kill('SIGCONT');
  assert.equal(await headExited, 0, stderr);
});

test('heavyweight admission reserves unused admitted class memory and releases it on exit and stale reap', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-reservations-' });
  const observedPidsPath = fixture.path('worker-pids.json');
  await writeFile(observedPidsPath, '[]');
  const { launcher, admissionRoot: admission } = await installNativeAdmissionFixture({ root: fixture.root, observedPidsPath });
  const memory = fixture.path('memory');
  const compilationKiB = resolveHeavyweightMemoryFloorKiB('compilation');
  const totalKiB = compilationKiB * 3;
  await writeFile(memory, `37748736 ${totalKiB}\n`);
  const release = fixture.path('release');
  const marker = fixture.path('started');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) /usr/bin/awk '{print $1, $2}' "$FIXTURE_MEMORY" ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, FIXTURE_MEMORY: memory,
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const args = ['--admission-root=' + admission, '--class=compilation', '--machine=fixture'];
  const owner = spawn('/bin/sh', [launcher, '--heavyweight-admission', ...args, '--', '/bin/sh', '-c', 'touch "$1"; while [ ! -e "$2" ]; do sleep 0.02; done', 'hold', marker, release], { env });
  let stderr = '';
  owner.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolveExit => owner.once('exit', resolveExit));
  let contender;
  let contenderExited;
  try {
    for (let attempt = 0; ; attempt++) {
      try { await readFile(marker); break; } catch (error) {
        if (error.code !== 'ENOENT' || attempt === 250 || owner.exitCode !== null) throw new Error(`owner did not start: ${stderr}`);
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
      }
    }
    const secondMarker = fixture.path('second-started');
    let contenderErr = '';
    contender = spawn('/bin/sh', [launcher, '--heavyweight-admission', ...args, '--', '/bin/sh', '-c', 'touch "$1"', 'second', secondMarker], { env });
    contender.stderr.on('data', chunk => { contenderErr += chunk; });
    contenderExited = new Promise(resolveExit => contender.once('exit', resolveExit));
    for (let attempt = 0; !contenderErr.includes('waiting for heavyweight admission') && contender.exitCode === null; attempt++) {
      if (attempt === 250) throw new Error(`contender did not decide admission: ${contenderErr}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    await assert.rejects(readFile(secondMarker), { code: 'ENOENT' }, 'a second 21 GiB class must wait while the first reservation consumes its headroom');
    assert.match(contenderErr, new RegExp(`reserved-memory=${compilationKiB}`), 'an unobserved owner retains the full class reservation');
    const fullFloorKiB = Number(/ reserved-memory=(\d+)/.exec(contenderErr)?.[1]);
    await writeFile(release, '');
    assert.equal(await exited, 0, stderr);
    assert.equal(await contenderExited, 0, contenderErr);
    await readFile(secondMarker);
    const probe = () => spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', ...args], { env, encoding: 'utf8' });
    // Reentrant owner records are the same authority used by the live probe.
    const token = (await readFile(`/proc/${process.pid}/stat`, 'utf8')).split(') ').at(-1).split(' ')[19];
    const reserved = join(admission, `owners/${process.pid}-${token}`);
    await mkdir(reserved);
    await writeFile(join(reserved, 'process'), `${process.pid} ${token}\n`);
    await writeFile(join(reserved, 'class'), 'compilation\n');
    await writeFile(observedPidsPath, JSON.stringify([process.pid]));
    const blocked = probe();
    assert.equal(blocked.status, 1, blocked.stderr);
    const unusedKiB = Number(/ reserved-memory=(\d+)/.exec(blocked.stderr)?.[1]);
    assert.ok(unusedKiB > 0 && unusedKiB < fullFloorKiB, 'a recorded live owner reserves only its unused class envelope');
    const memorySample = spawnSync('/bin/sh', [launcher, '--heavyweight-memory-sample'], { env, encoding: 'utf8' });
    assert.equal(memorySample.status, 0, memorySample.stderr);
    const sample = JSON.parse(memorySample.stdout);
    assert.equal(sample.availableMemoryKiB, 37748736);
    assert.ok(sample.reservedMemoryKiB > 0 && sample.reservedMemoryKiB < fullFloorKiB);
    assert.equal(sample.unreservedMemoryKiB, 37748736 - sample.reservedMemoryKiB,
      'pin selection uses the same resident-RSS credit as admission, without subtracting services twice');
    const declined = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait', ...args, '--', '/bin/sh', '-c', 'exit 42'], { env, encoding: 'utf8' });
    assert.equal(declined.status, 75, declined.stderr);
    assert.match(declined.stderr, /heavyweight admission declined before dispatch/);
    // Lower classes still fit; reservations impose memory capacity, not one job.
    const light = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', '--admission-root=' + admission, '--class=validation', '--machine=fixture'], { env, encoding: 'utf8' });
    assert.equal(light.status, 0, light.stderr);
    const processMemory = readLinuxWorkerProcesses().get(process.pid);
    const residentKiB = processMemory.pssKiB ?? processMemory.rssKiB;
    // This headroom cannot fit two full envelopes, but can fit the new class
    // after crediting the authenticated live owner's already-resident memory.
    await writeFile(memory, `${fullFloorKiB * 2 - Math.floor(residentKiB / 2)} ${totalKiB}\n`);
    const residentCredit = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--no-wait', ...args,
      '--', '/usr/bin/printf', 'unused-reservation-admitted'], { env, encoding: 'utf8' });
    assert.equal(residentCredit.status, 0, residentCredit.stderr);
    assert.equal(residentCredit.stdout, 'unused-reservation-admitted');
    const { rm } = await import('node:fs/promises');
    await rm(reserved, { recursive: true });
    assert.equal(probe().status, 0);
    const stale = join(admission, 'owners/99999999-stale');
    await mkdir(stale);
    await writeFile(join(stale, 'process'), '99999999 1\n');
    await writeFile(join(stale, 'class'), 'compilation\n');
    const staleSample = spawnSync('/bin/sh', [launcher, '--heavyweight-memory-sample'], { env, encoding: 'utf8' });
    assert.equal(staleSample.status, 0, staleSample.stderr);
    assert.equal(JSON.parse(staleSample.stdout).reservedMemoryKiB, 0);
    assert.equal(await readFile(join(stale, 'process'), 'utf8'), '99999999 1\n', 'observation never reclaims stale owner records');
    assert.equal(probe().status, 0, 'dead owner must release its memory reservation');
  } finally {
    await writeFile(release, '');
    if (owner.exitCode === null) owner.kill('SIGTERM');
    if (contender && contender.exitCode === null) contender.kill('SIGTERM');
    await exited;
    await contenderExited;
  }
});

test('heavyweight admission reclaims terminal owners and waiters but retains idle orphaned live owners', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-terminal-admission-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const identityPath = join(launcher, '../..', 'scripts/utils/proc/native_process_identity.sh');
  const stat = fixture.path('owner.stat');
  const identity = await readFile(identityPath, 'utf8');
  // Replace only the kernel stat boundary; use real reservation, queue and memory decisions.
  await writeFile(identityPath, identity.replaceAll('/proc/$heavyweight_token_pid/stat', stat)
    .replaceAll('/proc/$heavyweight_current_pid/stat', stat));
  const owner = join(admissionRoot, 'owners/99999999-12345');
  const waiter = join(admissionRoot, 'waiters/99999999-12345');
  const floor = resolveHeavyweightMemoryFloorKiB('validation');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '${floor} ${floor * 3}\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const probe = () => spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check',
    '--class=validation', '--machine=fixture'], { env, encoding: 'utf8' });
  const observer = new URL('./utils/proc/service_memory.mjs', import.meta.url).href;
  const observerPath = join(launcher, '../..', 'scripts/utils/proc/service_memory.mjs');
  const processSnapshot = new Map([[99999999, { pid: 99999999, parentPid: 1, state: 'Z',
    fingerprint: 'linux-proc:12345', rssKiB: 0, env: {} }],
  [99999998, { pid: 99999998, parentPid: 1, state: 'S', rssKiB: 1024,
    env: { HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: admissionRoot, HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '99999999:12345' } }]]);
  await mkdir(owner, { recursive: true });
  await writeFile(join(owner, 'process'), '99999999 12345\n');
  await writeFile(join(owner, 'class'), 'validation\n');
  await writeFile(stat, `99999999 (orphan owner) Z 1 ${Array(17).fill('0').join(' ')} 12345\n`);
  const originalObserver = await readFile(observerPath, 'utf8');
  // Replace the existing fixture's OS enumeration, preserving the real owner logic.
  const writeProcessSnapshot = () => writeFile(observerPath, `import { readWorkerMemoryReservations, renderWorkerMemoryReservationRows } from ${JSON.stringify(observer)};
const processes = new Map(${JSON.stringify([...processSnapshot])});
process.stdout.write(renderWorkerMemoryReservationRows(readWorkerMemoryReservations({ admissionRoot: ${JSON.stringify(admissionRoot)}, readProcesses: () => processes, includeAdmittedRss: true, includeOwnerProgress: true })));
`);
  await writeProcessSnapshot();
  const survivingWork = probe();
  assert.equal(survivingWork.status, 1, 'a terminal wrapper must not release a live admitted payload');
  assert.equal(await readFile(join(owner, 'process'), 'utf8'), '99999999 12345\n');
  delete processSnapshot.get(99999998).rssKiB;
  await writeProcessSnapshot();
  const unknownMemory = probe();
  assert.equal(unknownMemory.status, 1, 'unknown resident memory must not release the surviving workload');
  assert.match(unknownMemory.stderr, new RegExp(`reserved-memory=${floor}`), 'unknown RSS retains the entire class envelope');
  await writeFile(observerPath, originalObserver);
  for (const state of ['S', 'D', 'T', 'Z', 'X']) {
    await mkdir(owner, { recursive: true });
    await writeFile(join(owner, 'process'), '99999999 12345\n');
    await writeFile(join(owner, 'class'), 'validation\n');
    await writeFile(stat, `99999999 (orphan owner) ${state} 1 ${Array(17).fill('0').join(' ')} 12345\n`);
    const decision = probe();
    if (['Z', 'X'].includes(state)) {
      assert.equal(decision.status, 0, decision.stderr);
      await assert.rejects(readFile(join(owner, 'process')), { code: 'ENOENT' });
      assert.match(decision.stderr, /reclaimed heavyweight owner.*99999999/);
    } else {
      assert.equal(decision.status, 1, decision.stderr);
      assert.match(decision.stderr, new RegExp(`reserved-memory=${floor}`));
      assert.equal(await readFile(join(owner, 'process'), 'utf8'), '99999999 12345\n');
    }
  }
  await mkdir(join(admissionRoot, 'waiters'), { recursive: true });
  await writeFile(waiter, '99999999 12345 1 validation 0\n');
  const afterTerminalWaiter = probe();
  assert.equal(afterTerminalWaiter.status, 0, afterTerminalWaiter.stderr);
  await assert.rejects(readFile(waiter), { code: 'ENOENT' });
});

test('reclaims a reservation when its recorded PID belongs to another process incarnation', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-retired-owner-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const currentToken = (await readFile(`/proc/${process.pid}/stat`, 'utf8')).split(') ').at(-1).split(' ')[19];
  const retiredToken = String(BigInt(currentToken) + 1n);
  const owner = join(admissionRoot, 'owners', `${process.pid}-${retiredToken}`);
  await mkdir(owner, { recursive: true });
  await writeFile(join(owner, 'process'), `${process.pid} ${retiredToken}\n`);
  await writeFile(join(owner, 'class'), 'compilation\n');
  const floor = resolveHeavyweightMemoryFloorKiB('validation');
  // An existing PID alone cannot retain an earlier incarnation's reservation.
  // The available memory fits validation only if the stale envelope is ignored.
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '${floor} ${floor * 3}\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', '--class=validation', '--machine=fixture'], {
    encoding: 'utf8', env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
      HAPPIER_STACK_PM_CACHE_BASE_DIR: '',
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(owner), { code: 'ENOENT' }, 'a stale process incarnation must release its reservation');
  assert.match(result.stderr, /reclaimed heavyweight owner/);
});

test('reclaims a released owner record without a shell open error', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-released-owner-read-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const releasedOwner = join(admissionRoot, 'owners', '99999999-1');
  await mkdir(releasedOwner, { recursive: true });
  // Model owner release having unlinked its process file before its class file.
  await writeFile(join(releasedOwner, 'class'), 'validation\n');
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '37748736 47185920\\n' ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', '--class=validation', '--machine=fixture'], {
    encoding: 'utf8', env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, HAPPIER_STACK_PM_CACHE_BASE_DIR: '',
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /cannot open.*\/process/);
  await assert.rejects(access(releasedOwner), { code: 'ENOENT' });
});
