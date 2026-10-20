// Run with native Windows Node (not WSL Node), beside the current writer source.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

assert.equal(process.platform, 'win32', 'This check requires native Windows Node');
const realOpen = fs.open;
let flushed = false;
let afterSync = null;
fs.open = async (...args) => {
  const handle = await realOpen(...args);
  const sync = handle.sync.bind(handle);
  handle.sync = async () => { await sync(); flushed = true; afterSync?.(); };
  return handle;
};
syncBuiltinESMExports();
const { writeFileAtomically } = await import('./writeJsonAtomic.ts');
const root = await fs.mkdtemp(join(tmpdir(), 'happier-native-atomic-'));
const path = join(root, 'file.txt');
const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex');
let holder;

async function holdWithoutDeleteShare() {
  const literal = path.replaceAll("'", "''");
  holder = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$s=[System.IO.File]::Open('${literal}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::ReadWrite); Write-Output 'READY'; $null=[Console]::ReadLine(); $s.Dispose()`],
  { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.once('exit', code => reject(new Error(`File holder exited before ready: ${code}`)));
    holder.stdout.on('data', chunk => { if (String(chunk).includes('READY')) resolve(); });
  });
}
async function release() {
  if (!holder || holder.exitCode !== null) return;
  const exited = once(holder, 'exit');
  holder.stdin.end('\n');
  await exited;
  holder = null;
}
try {
  await fs.writeFile(path, 'before');
  await holdWithoutDeleteShare();
  let attempts = 0;
  await assert.rejects(writeFileAtomically({ path, mode: 'preserve', fsync: true,
    writeTemporaryFile: temporary => fs.writeFile(temporary, 'mine'),
    beforeCommit: () => { attempts++; assert.equal(flushed, true, 'Staged bytes must be fsynced before rename'); },
  }), error => ['EPERM', 'EBUSY', 'EEXIST'].includes(error.code));
  assert.equal(attempts, 5);
  assert.equal(await fs.readFile(path, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(root), ['file.txt']);

  const expected = hash();
  const conflict = new Error('hash_mismatch');
  attempts = 0;
  await assert.rejects(writeFileAtomically({ path, mode: 'preserve', fsync: true,
    writeTemporaryFile: temporary => fs.writeFile(temporary, 'mine'),
    beforeCommit: () => {
      attempts++;
      if (attempts === 2) writeFileSync(path, 'agent');
      if (hash() !== expected) throw conflict;
    },
  }), error => error === conflict);
  assert.equal(attempts, 2);
  assert.equal(await fs.readFile(path, 'utf8'), 'agent');
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
  await release();
  await writeFileAtomically({ path, mode: 'preserve', fsync: true,
    writeTemporaryFile: temporary => fs.writeFile(temporary, 'mine') });
  assert.equal(await fs.readFile(path, 'utf8'), 'mine');
  if (process.argv[2]) {
    const { pathToFileURL } = await import('node:url');
    const { commitGuardedFileReplace } = await import(pathToFileURL(process.argv[2]).href);
    await holdWithoutDeleteShare();
    const held = await commitGuardedFileReplace({ destPath: path, expectation: hash(),
      source: { kind: 'bytes', bytes: Buffer.from('replacement') } });
    assert.equal(held.success, false);
    assert.equal(held.errorCode, 'file_replace_failed');
    const heldDelete = await commitGuardedFileReplace({ destPath: path, expectation: hash(), source: { kind: 'absent' } });
    assert.equal(heldDelete.success, false);
    assert.equal(heldDelete.errorCode, 'file_replace_failed');
    assert.equal(await fs.readFile(path, 'utf8'), 'mine');
    assert.deepEqual(await fs.readdir(root), ['file.txt']);
    await release();
    const expected = hash();
    afterSync = () => writeFileSync(path, 'agent');
    const raced = await commitGuardedFileReplace({ destPath: path, expectation: expected,
      source: { kind: 'bytes', bytes: Buffer.from('replacement') } });
    afterSync = null;
    assert.equal(raced.success, false);
    assert.equal(raced.errorCode, 'hash_mismatch');
    assert.equal(await fs.readFile(path, 'utf8'), 'agent');
    assert.deepEqual(await fs.readdir(root), ['file.txt']);
    assert.deepEqual(await commitGuardedFileReplace({ destPath: path, expectation: hash(), source: { kind: 'absent' } }),
      { success: true, hash: null });
    await assert.rejects(fs.stat(path), { code: 'ENOENT' });
    console.log('PASS native Windows guard: typed held-file failure, concurrent-content conflict, guarded deletion');
  }
  console.log('PASS native Windows: fsync, held-file retries/exhaustion, hash fence per retry, cleanup, replacement after release');
} finally {
  await release();
  await fs.rm(root, { recursive: true, force: true });
}
