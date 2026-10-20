import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitGuardedFileReplace } from './commitGuardedFileReplace';
import fileHashVectors from '../../../../../../packages/protocol/src/actions/__fixtures__/fileHashVectors.json';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-guarded-replace-'));
  roots.push(root);
  return { root, path: join(root, 'file') };
}

describe('commitGuardedFileReplace', () => {
  it('checks the hash after asynchronous authority preparation and before publication', async () => {
    const { path } = await fixture();
    await writeFile(path, 'before');
    const result = await commitGuardedFileReplace({
      destPath: path,
      expectation: hash('before'),
      source: { kind: 'bytes', bytes: Buffer.from('mine') },
      prepareCommit: async () => { await writeFile(path, 'agent changed this'); },
    });
    expect(result).toMatchObject({ success: false, errorCode: 'hash_mismatch' });
    expect(await readFile(path, 'utf8')).toBe('agent changed this');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves OS refusal to overwrite an existing read-only file', async () => {
    const { root, path } = await fixture();
    await writeFile(path, 'before');
    await chmod(path, 0o444);
    await expect(writeFile(path, 'mine')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await commitGuardedFileReplace({ destPath: path, expectation: hash('before'), source: { kind: 'bytes', bytes: Buffer.from('mine') } }))
      .toMatchObject({ success: false, errorCode: 'file_replace_failed' });
    expect(await readFile(path, 'utf8')).toBe('before');
    expect(await readdir(root)).toEqual(['file']);
  });
  it('deletes an untouched added file through the same hash guard and preserves a changed file', async () => {
    const { root, path } = await fixture();
    await writeFile(path, 'added');
    expect(await commitGuardedFileReplace({ destPath: path, expectation: hash('other'), source: { kind: 'absent' } }))
      .toMatchObject({ success: false, errorCode: 'hash_mismatch' });
    expect(await readFile(path, 'utf8')).toBe('added');
    expect(await commitGuardedFileReplace({ destPath: path, expectation: hash('added'), source: { kind: 'absent' } }))
      .toEqual({ success: true, hash: null });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path, 'target');
    const link = join(root, 'link');
    await symlink(path, link);
    expect(await commitGuardedFileReplace({ destPath: link, expectation: hash('target'), source: { kind: 'absent' } }))
      .toEqual({ success: true, hash: null });
    expect(await readFile(path, 'utf8')).toBe('target');
    expect(await readdir(root)).toEqual(['file']);
  });
  it.each(fileHashVectors)('shares the raw-byte hash basis for $name with the UI decoder', async vector => {
    const { path } = await fixture();
    const bytes = Buffer.from(vector.base64, 'base64');
    await writeFile(path, bytes);
    expect(await commitGuardedFileReplace({ destPath: path, expectation: vector.sha256,
      source: { kind: 'bytes', bytes } })).toEqual({ success: true, hash: vector.sha256 });
    expect(await readFile(path)).toEqual(bytes);
  });
  it('distinguishes must-exist, must-not-exist and mismatched-content conflicts without mutation', async () => {
    const { root, path } = await fixture();
    const source = { kind: 'bytes', bytes: Buffer.from('mine') } as const;
    expect(await commitGuardedFileReplace({ destPath: path, expectation: hash('before'), source }))
      .toMatchObject({ success: false, errorCode: 'expected_file_missing' });
    await writeFile(path, 'before');
    expect(await commitGuardedFileReplace({ destPath: path, expectation: null, source }))
      .toMatchObject({ success: false, errorCode: 'expected_file_absent' });
    expect(await commitGuardedFileReplace({ destPath: path, expectation: hash('other'), source }))
      .toMatchObject({ success: false, errorCode: 'hash_mismatch' });
    expect(await readFile(path, 'utf8')).toBe('before');
    expect(await readdir(root)).toEqual(['file']);
  });

  it('updates the real target of a symlink, preserving its permission bits', async () => {
    const { root, path } = await fixture();
    const link = join(root, 'link');
    await writeFile(path, 'before', { mode: 0o751 });
    await chmod(path, 0o751);
    await symlink(path, link);
    expect(await commitGuardedFileReplace({ destPath: link, expectation: hash('before'),
      source: { kind: 'bytes', bytes: Buffer.from('mine') } })).toEqual({ success: true, hash: hash('mine') });
    expect(await readFile(path, 'utf8')).toBe('mine');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o751);
    expect(await readdir(root)).toEqual(['file', 'link']);
  });

  it('never exposes partial destination bytes while publishing and verifying a large staged file', async () => {
    const { root, path } = await fixture();
    const stage = join(root, 'stage');
    const before = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const after = Buffer.alloc(3 * 1024 * 1024, 0x62);
    await writeFile(path, before);
    await writeFile(stage, after);
    let stagedMode = 0;
    let publishing = true;
    const reader = (async () => {
      do {
        const seen = await readFile(path);
        expect(seen.equals(before) || seen.equals(after)).toBe(true);
      } while (publishing);
    })();
    try {
      expect(await commitGuardedFileReplace({ destPath: path, expectation: hash(before),
        source: { kind: 'staged', path: stage, sha256: hash(after) }, fileOperations: { copyFile, rm,
          rename: async (from, to) => {
            if (from === stage) stagedMode = (await stat(from)).mode & 0o777;
            await rename(from, to);
          } } })).toEqual({ success: true, hash: hash(after) });
    } finally { publishing = false; await reader; }
    expect(await readFile(path)).toEqual(after);
    if (process.platform !== 'win32') expect(stagedMode).toBe(0o600);
    expect(await readdir(root)).toEqual(['file']);
  });
});
