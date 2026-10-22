import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { watch } from 'node:fs';

import { pruneStackRunnerLogs, watchStackRunnerLogRetention } from './runner_log_retention.mjs';
import { runNodeCapture } from '../../testkit/core/run_node_capture.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';

test('runner log retention preserves the active runner, newest bounded history, and unrelated logs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runner-log-retention-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });

  const oldest = join(root, 'dev.100.log');
  const active = join(root, 'dev.200.log');
  const newest = join(root, 'run.300.log');
  const unrelated = join(root, 'server.log');
  await writeFile(oldest, 'oldest');
  await writeFile(active, 'active');
  await writeFile(newest, 'newest');
  await writeFile(unrelated, 'server');

  const result = await pruneStackRunnerLogs({
    logsDir: root,
    preservePaths: [active],
    keepCount: 1,
    maxTotalBytes: 1024,
  });

  assert.deepEqual(result.removedPaths, [oldest]);
  assert.deepEqual((await readdir(root)).sort(), [
    'dev.200.log',
    'run.300.log',
    'server.log',
  ]);
  assert.equal(await readFile(active, 'utf8'), 'active');
  assert.equal(await readFile(unrelated, 'utf8'), 'server');
});

test('runner log retention keeps one newest runner even when it exceeds the byte budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runner-log-budget-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'dev.100.log'), 'older');
  await writeFile(join(root, 'dev.200.log'), 'newest-is-larger-than-budget');

  await pruneStackRunnerLogs({
    logsDir: root,
    keepCount: 8,
    maxTotalBytes: 1,
  });

  assert.deepEqual(await readdir(root), ['dev.200.log']);
});

test('active runner rotation bounds history and preserves append descriptors and the reader path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runner-log-active-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const active = join(root, 'run.200.log');
  const writer = await open(active, 'a');
  t.after(() => writer.close());
  const originalInode = (await writer.stat()).ino;
  await writeFile(join(root, 'run.100.log'), 'older history'.repeat(50));
  const options = { logsDir: root, activeLogPath: active, maxTotalBytes: 1024 };
  await writer.write('below budget\n');
  await pruneStackRunnerLogs(options);
  assert.equal(await readFile(active, 'utf8'), 'below budget\n');
  await writer.write('x'.repeat(2048) + '\nrecent diagnostic\n');
  await pruneStackRunnerLogs(options);
  assert.ok((await stat(active)).size <= 512, 'active log must rotate at half the history byte budget');
  assert.equal((await stat(active)).ino, originalInode, 'inherited stdout/stderr must keep their destination');
  assert.match(await readFile(active, 'utf8'), /runner log rotated/);
  assert.ok((await stat(`${active}.1`)).size <= 512);
  assert.match(await readFile(`${active}.1`, 'utf8'), /recent diagnostic/);
  await writer.write('stdout after rotation\nstderr after rotation\n');
  assert.match(await readFile(active, 'utf8'), /stdout after rotation\nstderr after rotation/);
  await writer.write('y'.repeat(2048) + '\nsecond diagnostic\n');
  await pruneStackRunnerLogs(options);
  assert.match(await readFile(`${active}.1`, 'utf8'), /second diagnostic/);
  assert.doesNotMatch(await readFile(`${active}.1`, 'utf8'), /recent diagnostic/);
  assert.deepEqual((await readdir(root)).sort(), ['run.200.log', 'run.200.log.1']);
});

test('runner watcher rotates new output without another launch and stops when closed', { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runner-log-watch-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const active = join(root, 'dev.300.log');
  const writer = await open(active, 'a');
  t.after(() => writer.close());
  const errors = [];
  const close = watchStackRunnerLogRetention({ logPath: active, maxTotalBytes: 1024, onError: error => errors.push(error) });
  t.after(close);
  const rotation = new Promise((resolveRotation, reject) => {
    const reader = watch(active, async () => {
      try {
        if ((await readFile(active, 'utf8')).includes('runner log rotated')) resolveRotation();
      } catch (error) { reject(error); }
    });
    t.after(() => reader.close());
  });
  await writer.write('new output'.repeat(200));
  await rotation;
  await close();
  assert.deepEqual(errors, []);
  await writer.write('after watcher closed'.repeat(200));
  assert.match(await readFile(active, 'utf8'), /after watcher closed/);
});

test('runner rotation failures preserve diagnostic output and missing watchers report without taking down startup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runner-log-error-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const active = join(root, 'run.500.log');
  const content = 'keep original diagnostics\n'.repeat(100);
  await writeFile(active, content);
  await mkdir(`${active}.1`);
  await assert.rejects(pruneStackRunnerLogs({ logsDir: root, activeLogPath: active, maxTotalBytes: 1024 }));
  assert.equal(await readFile(active, 'utf8'), content);
  const errors = [];
  assert.doesNotThrow(() => watchStackRunnerLogRetention({
    logPath: join(root, 'missing', 'run.500.log'), onError: error => errors.push(error.code),
  }));
  assert.deepEqual(errors, ['ENOENT']);
});

test('real run and dev entrypoints retain their redirected runner output across env loading', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runner-log-entry-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  for (const name of ['run', 'dev']) {
    const active = join(root, `${name}.400.log`);
    const writer = await open(active, 'a');
    try {
      // Sparse fixture crosses the real 64 MiB threshold without manufacturing
      // a separate test-only runtime setting. --help never starts a Stack.
      await writer.truncate(64 * 1024 * 1024 + 1);
      const result = await runNodeCapture([fileURLToPath(new URL(`../../${name}.mjs`, import.meta.url)), '--help'], {
        env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: root }),
          HAPPIER_STACK_RUNNER_LOG_PATH: active },
        stdio: ['ignore', writer.fd, writer.fd],
      });
      assert.equal(result.code, 0, `${name} help entry failed`);
      assert.ok((await stat(active)).size <= 64 * 1024 * 1024, `${name} entry did not rotate its active log`);
      assert.match(await readFile(active, 'utf8'), /runner log rotated/);
      assert.ok((await stat(`${active}.1`)).size <= 64 * 1024 * 1024);
      await writer.write('existing stdout after real entry\n');
      assert.match(await readFile(active, 'utf8'), /existing stdout after real entry/);
    } finally {
      await writer.close();
    }
  }
});
