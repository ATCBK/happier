import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { describeJsonOwnerLockOwner, withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';

test('writer re-entry reuses its live process ticket without losing queue position', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-writer-reentry-' });
  const lockPath = fixture.path('owner.lock');
  const waitersDir = `${lockPath}.waiters`;
  await mkdir(waitersDir);
  const original = { pid: process.pid, priority: 'writer', createdAtMs: Date.now() - 1000, updatedAtMs: Date.now() };
  const ticketPath = join(waitersDir, '1.json');
  await writeFile(ticketPath, JSON.stringify(original));
  const holderRaw = JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() });
  await writeFile(lockPath, holderRaw);
  let notify;
  const waiting = new Promise(resolve => { notify = resolve; });
  const cancellation = new AbortController();
  const writer = withJsonOwnerFileLock(() => assert.fail('writer entered the held lock'), {
    lockPath, priority: 'writer', sharedReaders: true, signal: cancellation.signal, onWait: notify,
  });
  const outcome = writer.catch(error => error.name);
  try {
    await waiting;
    assert.deepEqual(await readdir(waitersDir), ['1.json'], 're-entry must adopt its original ticket, not append a new one');
    assert.equal(JSON.parse(await readFile(ticketPath, 'utf8')).createdAtMs, original.createdAtMs);
  } finally {
    cancellation.abort();
    assert.equal(await outcome, 'AbortError');
  }
  assert.deepEqual(await readdir(waitersDir), [], 'cancellation removes the retained ticket');
  assert.equal(await readFile(lockPath, 'utf8'), holderRaw);
});

test('release wakes queued JSON owners without the catch-up delay, including release during onWait', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-events-' });
  for (const duringOnWait of [false, true]) {
    const lockPath = fixture.path(`owner-${duringOnWait}.lock`);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), updatedAtMs: Date.now() }));
    let observed;
    const waiting = new Promise(resolve => { observed = resolve; });
    const contender = withJsonOwnerFileLock(async () => 'acquired', {
      lockPath, pollIntervalMs: 2_000, watchFallbackMs: 2_000, timeoutMs: 3_000,
      onWait() { observed(); if (duringOnWait) unlinkSync(lockPath); },
    });
    try {
      await waiting;
      if (!duringOnWait) { await delay(30); unlinkSync(lockPath); }
      assert.equal(await Promise.race([contender, delay(500).then(() => 'missed release')]), 'acquired');
    } finally { await contender; }
  }
});

test('JSON owner heartbeat-only changes do not rescan healthy contention', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-heartbeat-events-' });
  const lockPath = fixture.path('owner.lock');
  const createdAtMs = Date.now();
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs, updatedAtMs: createdAtMs }));
  const controller = new AbortController();
  let waits = 0;
  const contender = withJsonOwnerFileLock(async () => assert.fail('live owner must exclude contender'), {
    lockPath, pollIntervalMs: 125, signal: controller.signal, onWait() { waits++; },
  });
  const outcome = contender.catch(error => error.name);
  try {
    for (let i = 0; i < 8; i++) {
      await delay(50);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs, updatedAtMs: Date.now() }));
    }
    assert.equal(waits, 1, 'healthy contention must not wake for heartbeat writes or the old 250ms poll');
  } finally {
    controller.abort();
    assert.equal(await outcome, 'AbortError');
    unlinkSync(lockPath);
  }
});

test('waiters acquire in arrival order even with different catch-up intervals', async t => {
  const fixture = await createTempFixture(t, {prefix:'hstack-json-owner-fifo-'});
  const lockPath = fixture.path('owner.lock');
  const order = [];
  const tasks = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  tasks.push(withJsonOwnerFileLock(async () => { entered(); await held; }, {lockPath}));
  try {
    await entry;
    for (const [name, pollIntervalMs] of [['first', 300], ['second', 5], ['third', 5]]) {
      let observed;
      const waiting = new Promise(resolve => { observed = resolve; });
      tasks.push(withJsonOwnerFileLock(async ({waited}) => {
        assert.equal(waited, true);
        order.push(name);
      }, {lockPath, timeoutMs:3000, watchFallbackMs:pollIntervalMs, onWait:observed}));
      await waiting;
    }
    release();
    await Promise.all(tasks);
    assert.deepEqual(order, ['first', 'second', 'third']);
  } finally {
    release();
    await Promise.allSettled(tasks);
  }
});

test('a dead queued writer does not block new readers', async t => {
  const fixture = await createTempFixture(t, {prefix:'hstack-json-owner-dead-waiter-'});
  const lockPath = fixture.path('owner.lock');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const holder = withJsonOwnerFileLock(async () => { entered(); await held; }, {lockPath, sharedReaders:true, priority:'reader'});
  await entry;
  const script = `import {withJsonOwnerFileLock} from ${JSON.stringify(new URL('./jsonOwnerFileLock.mjs', import.meta.url).href)};
    await withJsonOwnerFileLock(async()=>{}, {lockPath:process.argv[1], timeoutMs:Infinity, sharedReaders:true, priority:'writer',
      onWait:()=>{process.stdout.write('waiting');}});`;
  const child = spawnTestProcess(process.execPath, ['--input-type=module', '--eval', script, lockPath], {stdio:['ignore','pipe','inherit']});
  let later;
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const queued = await readdir(`${lockPath}.waiters`).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    assert.equal(queued.length, 1, 'the waiting process must have joined the filesystem queue');
    await assert.rejects(withJsonOwnerFileLock(() => assert.fail('reader overtook live writer'), {
      lockPath, sharedReaders:true, priority:'reader', wait:false,
    }), { code:'EJSONOWNERFILELOCKBUSY' });
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    later = withJsonOwnerFileLock(async () => 'acquired', {lockPath, timeoutMs:1000, sharedReaders:true, priority:'reader', wait:false});
    assert.equal(await later, 'acquired');
    release();
    await holder;
    assert.deepEqual(await readdir(`${lockPath}.waiters`), []);
  } finally {
    release();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await Promise.allSettled([holder, later].filter(Boolean));
  }
});

test('shared reader death without a file event is recovered through catch-up', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-json-owner-death-events-' });
  const lockPath = fixture.path('owner.lock');
  const script = `import {withJsonOwnerFileLock} from ${JSON.stringify(new URL('./jsonOwnerFileLock.mjs', import.meta.url).href)};
    await withJsonOwnerFileLock(async()=>{process.stdout.write('held');process.stdin.resume();
      await new Promise(()=>{});}, {lockPath:process.argv[1], sharedReaders:true, priority:'reader'});`;
  const child = spawnTestProcess(process.execPath, ['--input-type=module', '--eval', script, lockPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let contender;
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const raw = await readFile(lockPath, 'utf8');
    let observed;
    const waiting = new Promise(resolve => { observed = resolve; });
    contender = withJsonOwnerFileLock(async () => 'recovered', { lockPath, watchFallbackMs: 100,
      timeoutMs: 2_000, onWait: observed, sharedReaders:true, priority:'writer' });
    await waiting;
    child.kill('SIGKILL'); await exited;
    assert.equal(await readFile(lockPath, 'utf8'), raw, 'death left the held file intact');
    assert.equal(await contender, 'recovered');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await contender;
  }
});

test('stale malformed queue heads use the existing mtime reclaim rule', async t => {
  const fixture = await createTempFixture(t, {prefix:'hstack-json-owner-stale-head-'});
  const lockPath = fixture.path('owner.lock');
  await mkdir(`${lockPath}.waiters`);
  const head = join(`${lockPath}.waiters`, '1.json');
  await writeFile(head, '{not json');
  const stale = new Date(Date.now() - 60_000);
  await utimes(head, stale, stale);
  assert.equal(await withJsonOwnerFileLock(async () => 'acquired', {
    lockPath, timeoutMs:1000, staleAfterMs:10, pollIntervalMs:5,
  }), 'acquired');
  assert.deepEqual(await readdir(`${lockPath}.waiters`), []);
});

test('a timed-out head leaves the queue and its successor can acquire', async t => {
  const fixture = await createTempFixture(t, {prefix:'hstack-json-owner-timeout-head-'});
  const lockPath = fixture.path('owner.lock');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  const holder = withJsonOwnerFileLock(async () => { entered(); await held; }, {lockPath});
  let next;
  try {
    await entry;
    await assert.rejects(withJsonOwnerFileLock(async () => assert.fail('head entered early'), {
      lockPath, timeoutMs:30, pollIntervalMs:5,
    }), /Timed out waiting/);
    assert.deepEqual(await readdir(`${lockPath}.waiters`), []);
    next = withJsonOwnerFileLock(async () => 'next', {lockPath, pollIntervalMs:5});
    release();
    assert.equal(await next, 'next');
  } finally {
    release();
    await Promise.allSettled([holder, next].filter(Boolean));
  }
});

test('legacy exclusive-create contenders can bypass the queue without deadlocking queued waiters', async t => {
  const fixture = await createTempFixture(t, {prefix:'hstack-json-owner-legacy-'});
  const lockPath = fixture.path('owner.lock');
  const legacyRaw = JSON.stringify({pid:process.pid, createdAtMs:Date.now(), updatedAtMs:Date.now()});
  // The preceding implementation's shared-file protocol: wx plus PID/heartbeat
  // JSON, with no knowledge of queue entries or the registration lock.
  writeFileSync(lockPath, legacyRaw, {flag:'wx'});
  const order = [];
  const tasks = [];
  try {
    for (const [name, pollIntervalMs] of [['first', 100], ['second', 5]]) {
      let observed;
      const waiting = new Promise(resolve => { observed = resolve; });
      tasks.push(withJsonOwnerFileLock(async () => order.push(name), {
        lockPath, timeoutMs:2000, pollIntervalMs, onWait:observed,
      }));
      await waiting;
    }
    unlinkSync(lockPath);
    writeFileSync(lockPath, legacyRaw, {flag:'wx'}); // An already loaded legacy waiter wins.
    await delay(20);
    assert.deepEqual(order, [], 'queued code must still exclude a legacy owner');
    unlinkSync(lockPath);
    await Promise.all(tasks);
    assert.deepEqual(order, ['first', 'second']);
  } finally {
    if (await readFile(lockPath, 'utf8').catch(() => null) === legacyRaw) unlinkSync(lockPath);
    await Promise.allSettled(tasks);
  }
});

test('describeJsonOwnerLockOwner distinguishes total hold time from heartbeat freshness', () => {
  assert.equal(
    describeJsonOwnerLockOwner({ pid: 42, createdAtMs: 1_000, updatedAtMs: 9_000 }, 10_000),
    'pid=42 heldMs=9000 heartbeatAgeMs=1000',
  );
});

test('withJsonOwnerFileLock reclaims a stale malformed owner using the file mtime fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-malformed-'));
  const lockPath = join(root, 'owner.lock');

  try {
    await writeFile(lockPath, '{not json', 'utf8');
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const result = await withJsonOwnerFileLock(
      async () => {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 10,
        staleAfterMs: 10,
      },
    );

    assert.equal(result, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withJsonOwnerFileLock can narrowly reclaim a stale heartbeat from a reused live pid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-reused-live-pid-'));
  const lockPath = join(root, 'owner.lock');
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now() - 60_000,
      updatedAtMs: Date.now() - 60_000,
    }), 'utf8');
    const result = await withJsonOwnerFileLock(async () => 'reclaimed', {
      lockPath,
      timeoutMs: 200,
      pollIntervalMs: 10,
      staleAfterMs: 10,
      allowLiveOwnerStaleReclaim: true,
    });
    assert.equal(result, 'reclaimed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('live-owner stale reclaim preserves an actively heartbeating owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-active-heartbeat-'));
  const lockPath = join(root, 'owner.lock');
  let active = false;
  let releaseHolder;
  let holder;
  let contender;
  try {
    const holderReleased = new Promise((resolve) => { releaseHolder = resolve; });
    let holderEnteredResolve;
    const holderEntered = new Promise((resolve) => { holderEnteredResolve = resolve; });
    holder = withJsonOwnerFileLock(async () => {
      active = true;
      holderEnteredResolve();
      await holderReleased;
      active = false;
    }, { lockPath, timeoutMs: 3_000, pollIntervalMs: 20, staleAfterMs: 800, allowLiveOwnerStaleReclaim: true });
    await holderEntered;

    const initialOwner = JSON.parse(await readFile(lockPath, 'utf8'));
    const firstHeartbeat = initialOwner.updatedAtMs;
    const heartbeatDeadline = Date.now() + 2_000;
    let observedHeartbeat = false;
    while (Date.now() < heartbeatDeadline) {
      const owner = JSON.parse(await readFile(lockPath, 'utf8'));
      if (owner.updatedAtMs > firstHeartbeat) {
        assert.equal(owner.createdAtMs, initialOwner.createdAtMs, 'heartbeat must preserve the acquisition time');
        observedHeartbeat = true;
        break;
      }
      await delay(10);
    }
    assert.equal(observedHeartbeat, true, 'expected to observe a holder heartbeat before contention');

    let contenderWaitResolve;
    const contenderWait = new Promise((resolve) => { contenderWaitResolve = resolve; });
    contender = withJsonOwnerFileLock(async ({ waited }) => {
      assert.equal(waited, true);
      assert.equal(active, false);
    }, {
      lockPath,
      timeoutMs: 3_000,
      pollIntervalMs: 20,
      staleAfterMs: 800,
      allowLiveOwnerStaleReclaim: true,
      onWait: contenderWaitResolve,
    });
    await Promise.race([
      contenderWait,
      delay(2_000).then(() => { throw new Error('contender did not observe the active owner'); }),
    ]);
    assert.equal(active, true);
    releaseHolder();
    await Promise.all([holder, contender]);
  } finally {
    releaseHolder?.();
    await Promise.allSettled([holder, contender].filter(Boolean));
    await rm(root, { recursive: true, force: true });
  }
});

test('a cancelled contender stops waiting without disturbing the active owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-json-owner-lock-abort-'));
  const lockPath = join(root, 'owner.lock');
  const controller = new AbortController();
  let releaseHolder;
  const held = new Promise((resolve) => { releaseHolder = resolve; });
  let enteredHolder;
  const entered = new Promise((resolve) => { enteredHolder = resolve; });
  const holder = withJsonOwnerFileLock(async () => { enteredHolder(); await held; }, { lockPath });
  let contender;
  try {
    await entered;
    const originalOwner = await readFile(lockPath, 'utf8');
    contender = withJsonOwnerFileLock(async () => { throw new Error('cancelled contender acquired lock'); }, {
      lockPath,
      signal: controller.signal,
      onWait: () => controller.abort(),
    });
    const outcome = await Promise.race([
      contender.then(() => 'acquired', (error) => error?.name),
      delay(500).then(() => 'still_waiting'),
    ]);
    assert.equal(outcome, 'AbortError');
    assert.equal(await readFile(lockPath, 'utf8'), originalOwner);
    assert.deepEqual(await readdir(`${lockPath}.waiters`), [], 'cancellation must remove its queue entry');
  } finally {
    releaseHolder();
    await Promise.allSettled([holder, contender].filter(Boolean));
    await rm(root, { recursive: true, force: true });
  }
});
