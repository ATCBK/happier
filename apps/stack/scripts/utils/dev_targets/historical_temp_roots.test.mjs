import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, utimes, symlink, access, rm, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { reapHistoricalTempRoots } from './historical_temp_roots.mjs';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

test('same-UID procfs permission denial uses complete read-only observation, never a process-name exemption', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-proc-permission-' });
  const temp = join(root, 'tmp'), proc = join(root, 'proc');
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), `Name:\tunknown-native\nState:\tS\nUid:\t${Array(4).fill(process.getuid()).join('\t')}\n`);
  await writeFile(join(proc, '42', 'environ'), `PRIVATE_SECRET=must-not-be-emitted\0TMPDIR=${join(temp, 'happier-inherited')}\0`);
  await writeFile(join(proc, '42', 'maps'), '');
  const old = new Date(Date.now() - 48 * 3600000);
  for (const name of ['happier-old', 'happier-held', 'happier-inherited']) {
    await mkdir(join(temp, name), { recursive: true });
    await utimes(join(temp, name), old, old);
  }
  await symlink(join(temp, 'happier-held'), join(proc, '42', 'cwd'));
  const originals = Object.fromEntries(['readFileSync', 'readlinkSync', 'readdirSync', 'statSync', 'existsSync'].map(name => [name, fs[name]]));
  const fixturePath = path => typeof path === 'string' && (path === '/proc' || path.startsWith('/proc/')) ? proc + path.slice(5) : path;
  // Procfs/coreutils are the OS boundary. Keep the actual reaper and tree/inode
  // comparisons real; model the kernel's nondumpable same-user cwd denial.
  for (const [name, original] of Object.entries(originals)) t.mock.method(fs, name, (path, ...args) => {
    if (typeof path === 'string' && path.startsWith('/proc/42/') && !path.endsWith('/status') && name !== 'existsSync') {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return original(fixturePath(path), ...args);
  });
  let privilegedAvailable = false;
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'sudo');
    assert.ok(args.every(arg => !arg.includes('\0')), 'spawn arguments must not contain NUL bytes');
    assert.deepEqual(args.slice(0, 2), ['-n', '--']);
    if (!privilegedAvailable) return { status: 1, stdout: '', stderr: 'permission denied' };
    const path = args.find(arg => arg.startsWith('/proc/'));
    assert.ok(path?.startsWith('/proc/42/'), 'elevation is restricted to the observed process');
    if (args[2] === '/usr/bin/cat') return { status: 0, stdout: originals.readFileSync(fixturePath(path), 'utf8') };
    if (args[2] === '/usr/bin/readlink') return { status: 0, stdout: originals.readlinkSync(fixturePath(path)) + '\0' };
    if (args[2] === '/usr/bin/find') return { status: 0, stdout: originals.readdirSync(fixturePath(path)).map(name => name + '\0').join('') };
    if (args[2] === '/usr/bin/stat') {
      const info = originals.statSync(fixturePath(path));
      return { status: 0, stdout: `${info.dev}:${info.ino}\n` };
    }
    assert.fail('unexpected privileged command');
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(reapHistoricalTempRoots(temp).reclaimedRoots, 0, 'unavailable privileged observation must remain closed');
  privilegedAvailable = true;
  const result = reapHistoricalTempRoots(temp);
  assert.equal(result.observationUnavailable, null);
  assert.equal(result.reclaimedRoots, 1);
  await assert.rejects(access(join(temp, 'happier-old')), { code: 'ENOENT' });
  await access(join(temp, 'happier-held'));
  await access(join(temp, 'happier-inherited'));
});

test('historical sweep reclaims only old known roots with no cwd, fd or mapped-file users', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-historical-' });
  const temp = join(root, 'tmp'), proc = join(root, 'proc');
  await mkdir(temp);
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  // procfs is the genuine OS boundary; directory fixtures model cwd/fds/maps.
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  await writeFile(join(proc, '42', 'environ'), '');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const name of ['yarn--old', 'yarn--live', 'yarn--recent-child', 'happier-dev-test-old', 'happier-old', 'hstack-old', 'docs-check-old', 'happier-cwd', 'happier-fd', 'happier-mapped', 'happier-recent-child', 'happier-collision', 'happier-weird\\name', 'random-name']) {
    const dir = join(temp, name);
    await mkdir(dir);
    await writeFile(join(dir, 'data'), 'retained or reclaimed');
    await utimes(join(dir, 'data'), old, old);
    await utimes(dir, old, old);
  }
  await symlink(join(temp, 'happier-cwd'), join(proc, '42', 'cwd'));
  await symlink(join(temp, 'happier-fd', 'data'), join(proc, '42', 'fd', '9'));
  await symlink(join(temp, 'yarn--live', 'data'), join(proc, '42', 'fd', '11'));
  await symlink(join(temp, 'happier-collision') + '2/data', join(proc, '42', 'fd', '10'));
  await writeFile(join(proc, '42', 'maps'), `1-2 r--p 0 00:00 1 ${join(temp, 'happier-mapped', 'data')}\n`);
  await utimes(join(temp, 'happier-recent-child', 'data'), new Date(), new Date());
  await utimes(join(temp, 'yarn--recent-child', 'data'), new Date(), new Date());
  await symlink(join(temp, 'random-name'), join(temp, 'happier-symlink'));
  const result = reapHistoricalTempRoots(temp, proc);
  assert.equal(result.reclaimedRoots, 6);
  assert.ok(result.reclaimedBytes > 0);
  for (const name of ['yarn--old', 'happier-dev-test-old', 'happier-old', 'hstack-old', 'docs-check-old', 'happier-collision']) {
    await assert.rejects(access(join(temp, name)), { code: 'ENOENT' });
  }
  for (const name of ['yarn--live', 'yarn--recent-child', 'happier-cwd', 'happier-fd', 'happier-mapped', 'happier-recent-child', 'happier-weird\\name', 'random-name', 'happier-symlink']) await access(join(temp, name));
  assert.equal(reapHistoricalTempRoots(temp, proc).reclaimedRoots, 0);
});

test('historical sweep retains old roots when live process observation is unavailable', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-historical-unknown-' });
  const temp = join(root, 'tmp'), proc = join(root, 'proc');
  const dir = join(temp, 'happier-old');
  await mkdir(dir, { recursive: true });
  await mkdir(join(proc, '42'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(dir, old, old);
  const result = reapHistoricalTempRoots(temp, proc);
  assert.equal(result.reclaimedRoots, 0);
  assert.equal(result.retainedRoots, 1);
  await access(dir);
  await rm(join(proc, '42'), { recursive: true });
  assert.equal(reapHistoricalTempRoots(temp, proc).reclaimedRoots, 1);
});

test('sweep retains inherited TMPDIR and test roots before a detached process first uses them', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-inherited-scratch-' });
  const temp = join(root, 'tmp'), proc = join(root, 'proc');
  await mkdir(temp);
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  await symlink(root, join(proc, '42', 'cwd'));
  await writeFile(join(proc, '42', 'maps'), '');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const name of ['hstack-command', 'happier-test']) {
    await mkdir(join(temp, name));
    await utimes(join(temp, name), old, old);
  }
  await writeFile(join(proc, '42', 'environ'), `TMPDIR=${join(temp, 'hstack-command')}\0HAPPIER_TEST_TEMP_ROOTS=${join(temp, 'happier-test')}\0`);
  assert.equal(reapHistoricalTempRoots(temp, proc).reclaimedRoots, 0);
  for (const name of ['hstack-command', 'happier-test']) await access(join(temp, name));
  await rm(join(proc, '42'), { recursive: true });
  assert.equal(reapHistoricalTempRoots(temp, proc).reclaimedRoots, 2);
});

test('owner-supplied staging candidates reuse historical custody and retain mapped hard links and symlinks', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-staging-retention-' });
  const parent = join(root, 'runtime-build'), proc = join(root, 'proc');
  await mkdir(parent);
  await mkdir(join(proc, '42', 'fd'), { recursive: true });
  await writeFile(join(proc, '42', 'status'), 'State:\tS (sleeping)\n');
  await writeFile(join(proc, '42', 'environ'), '');
  await symlink(root, join(proc, '42', 'cwd'));
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const name of ['linux-arm64', 'darwin-arm64', 'unknown']) {
    await mkdir(join(parent, name));
    await writeFile(join(parent, name, 'output'), 'regenerable');
    await utimes(join(parent, name, 'output'), old, old);
    await utimes(join(parent, name), old, old);
  }
  await link(join(parent, 'darwin-arm64', 'output'), join(root, 'mapped-output'));
  await writeFile(join(proc, '42', 'maps'), `1-2 r--p 0 00:00 1 ${join(root, 'mapped-output')}\n`);
  await symlink(join(parent, 'unknown'), join(parent, 'linux-x64'));
  const result = reapHistoricalTempRoots(parent, proc, { candidateNames: ['linux-arm64', 'darwin-arm64', 'linux-x64'] });
  assert.equal(result.reclaimedRoots, 1);
  await assert.rejects(access(join(parent, 'linux-arm64')), { code: 'ENOENT' });
  for (const name of ['darwin-arm64', 'unknown', 'linux-x64']) await access(join(parent, name));
  assert.throws(() => reapHistoricalTempRoots(parent, proc, { candidateNames: ['../mapped-output'] }), /candidate/);
});

test('count-retention owners can reclaim recent unheld candidates while retaining another uid', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-count-retention-' });
  const parent = join(root, 'cache'), proc = join(root, 'proc');
  await mkdir(join(parent, 'obsolete'), { recursive: true });
  await mkdir(proc);
  await writeFile(join(parent, 'obsolete', 'data'), 'x'.repeat(8192));
  await link(join(parent, 'obsolete', 'data'), join(parent, 'obsolete', 'alias'));
  // Count retention still requires strictly past mtimes. Set them after the
  // hard link updates the directory, avoiding fresh/future filesystem timestamps.
  const recent = new Date(Date.now() - 60 * 1000);
  await utimes(join(parent, 'obsolete', 'data'), recent, recent);
  await utimes(join(parent, 'obsolete'), recent, recent);
  const allocatedBytes = ((await stat(join(parent, 'obsolete'))).blocks + (await stat(join(parent, 'obsolete', 'data'))).blocks) * 512;
  const options = { candidateNames: ['obsolete'], minimumAgeMs: 0 };
  assert.equal(reapHistoricalTempRoots(parent, proc, { ...options, ownerUid: process.getuid() + 1 }).reclaimedRoots, 0);
  const result = reapHistoricalTempRoots(parent, proc, options);
  assert.equal(result.reclaimedRoots, 1);
  assert.equal(result.reclaimedBytes, allocatedBytes, 'hard-linked Cargo outputs occupy storage once');
});
