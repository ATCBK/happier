import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { readProcessInstanceFingerprintSync } from '../processInstance.mjs';
import { createWindowsProtectedAclBoundarySync } from '../src/fs/windowsProtectedAcl.ts';
import { createHappierTempDir, getHappierTempRoot, getHappierTempDirOwnerPath, readHappierTempDirOwner,
  readHappierTempDirOwnerLiveness, removeHappierTempDir } from '../src/tempDirs/createHappierTempDir.ts';

test('native temporary ownership secures user root, empty payload and marker, and removes both', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-native-temp-test-'));
  try {
    const rootMode = statSync(root).mode;
    const directory = createHappierTempDir({ purpose: 'native-fixture', root });
    const parent = dirname(directory);
    const marker = getHappierTempDirOwnerPath(directory);
    const user = userInfo();
    const uid = user.uid >= 0 ? String(user.uid) : createHash('sha256').update(user.homedir).digest('hex');
    assert.equal(basename(parent), `happier-${uid}`);
    assert.deepEqual(readdirSync(directory), []);
    assert.equal(statSync(root).mode, rootMode);
    const owner = readHappierTempDirOwner(directory);
    assert.deepEqual(owner, { v: 1, purpose: 'native-fixture', pid: process.pid,
      processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid) });
    assert.equal(readHappierTempDirOwnerLiveness(owner), owner.processInstanceFingerprint ? 'alive' : 'unknown');
    t.diagnostic(JSON.stringify({ platform: process.platform, owner,
      liveness: readHappierTempDirOwnerLiveness(owner) }));
    assert.equal(readHappierTempDirOwnerLiveness({ ...owner, processInstanceFingerprint: null }), 'unknown');
    if (process.platform === 'win32') {
      const acl = createWindowsProtectedAclBoundarySync();
      acl.verify({ path: parent, kind: 'directory' });
      acl.verify({ path: directory, kind: 'directory' });
      acl.verify({ path: marker, kind: 'file' });
    } else {
      assert.equal(statSync(parent).mode & 0o777, 0o700);
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(marker).mode & 0o777, 0o600);
    }
    removeHappierTempDir(directory);
    removeHappierTempDir(directory);
    assert.equal(existsSync(directory), false);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native start identity distinguishes a current owner from an exited creator', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const owner = { v: 1, purpose: 'native-fixture', pid: child.pid,
    processInstanceFingerprint: readProcessInstanceFingerprintSync(child.pid) };
  assert.equal(readHappierTempDirOwnerLiveness(owner), owner.processInstanceFingerprint ? 'alive' : 'unknown');
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.equal(readHappierTempDirOwnerLiveness(owner), owner.processInstanceFingerprint ? 'gone' : 'unknown');
});

test('native default temporary directories expose physical paths for no-follow disk measurement', (t) => {
  const directory = createHappierTempDir({ purpose: 'native-default-fixture' });
  try {
    assert.equal(dirname(directory), getHappierTempRoot());
    assert.equal(dirname(dirname(directory)), realpathSync(tmpdir()));
    assert.equal(directory, realpathSync(directory));
    assert.equal(readHappierTempDirOwner(directory)?.purpose, 'native-default-fixture');
    t.diagnostic(JSON.stringify({ platform: process.platform, temporaryRoot: tmpdir(), directory }));
  } finally { removeHappierTempDir(directory); }
});
