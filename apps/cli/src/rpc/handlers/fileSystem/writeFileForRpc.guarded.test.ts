import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, symlink, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ destination: '', armed: false, stagedMode: 0 }));
// The filesystem is the system boundary: race a real external write with staging.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
    if (race.armed) {
      race.armed = false;
      await actual.writeFile(race.destination, 'agent changed this');
    }
    await actual.writeFile(...args);
    if (typeof args[0] === 'string' && basename(args[0]).startsWith('.tmp-')) race.stagedMode = (await actual.stat(args[0])).mode & 0o777;
  }) };
});

import { writeFileForRpc } from './writeFileForRpc';
import { createWriteFileRpcActionExecutor } from './writeFileHandler';
import { FilesystemWriteFileOutputSchema, isFilesystemWriteGuardErrorCode } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { OS_USER_FILESYSTEM_ACCESS_POLICY } from './accessPolicy/filesystemAccessPolicy';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-guarded-rpc-'));
  roots.push(root);
  return { root, path: join(root, 'file.txt'), deps: { workingDirectory: root,
    accessPolicy: OS_USER_FILESYSTEM_ACCESS_POLICY, getAdditionalAllowedWriteDirs: () => [] } };
}

afterEach(async () => {
  race.armed = false;
  race.stagedMode = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('guarded filesystem RPC', () => {
  it.each(['hash_mismatch', 'expected_file_missing', 'expected_file_absent'] as const)(
    'retains %s through the write Action response consumed by the editor', async errorCode => {
      const { root, path, deps } = await fixture();
      if (errorCode !== 'expected_file_missing') await writeFile(path, 'changed on disk');
      const result = await createWriteFileRpcActionExecutor(deps).execute('daemon.filesystem.writeFile', {
        rootPath: root, path, content: Buffer.from('mine').toString('base64'),
        expectedHash: errorCode === 'expected_file_absent' ? null : hash('before'),
      });
      if (!result.ok) throw new Error(result.error);
      const response = FilesystemWriteFileOutputSchema.parse(result.result);
      expect(response).toMatchObject({ success: false, errorCode });
      expect(!response.success && isFilesystemWriteGuardErrorCode(response.errorCode)).toBe(true);
      if (errorCode === 'expected_file_missing') {
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(await readFile(path, 'utf8')).toBe('changed on disk');
      }
    },
  );

  it('keeps private file bytes private before publication', async () => {
    const { path, deps } = await fixture();
    await writeFile(path, 'before', { mode: 0o600 });
    expect(await writeFileForRpc({ path, content: Buffer.from('mine').toString('base64'), expectedHash: hash('before') }, deps))
      .toEqual({ success: true, hash: hash('mine') });
    if (process.platform !== 'win32') {
      expect(race.stagedMode).toBe(0o600);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
  it('refuses a write that races between the initial hash check and publication', async () => {
    const { root, path, deps } = await fixture();
    await writeFile(path, 'before');
    race.destination = path;
    race.armed = true;
    const result = await writeFileForRpc({ path, content: Buffer.from('mine').toString('base64'), expectedHash: hash('before') }, deps);
    expect(result).toMatchObject({ success: false, errorCode: 'hash_mismatch' });
    expect(await readFile(path, 'utf8')).toBe('agent changed this');
    expect(await readdir(root)).toEqual(['file.txt']);
  });

  it('updates a symlink target and preserves executable bits', async () => {
    const { root, path, deps } = await fixture();
    const link = join(root, 'linked.txt');
    await writeFile(path, 'before', { mode: 0o751 });
    await chmod(path, 0o751);
    await symlink(path, link);
    const result = await writeFileForRpc({ path: link, content: Buffer.from('mine').toString('base64'), expectedHash: hash('before') }, deps);
    expect(result).toEqual({ success: true, hash: hash('mine') });
    expect(await readFile(path, 'utf8')).toBe('mine');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o751);
  });
});
