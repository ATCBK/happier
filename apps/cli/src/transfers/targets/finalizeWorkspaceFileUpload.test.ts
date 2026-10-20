import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile as copyFileMock, rename as renameMock, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransferSessionStore, createTransferSessionLifecycle, finalizeUploadTransferSession,
  openUploadTransferSession, writeUploadTransferChunk } from '@happier-dev/transfers/node';

const faults = vi.hoisted(() => ({ crossDevice: false, cleanupPath: '', publishPath: '', raceCopy: false }));
// Filesystem operations are the real external boundary; the transfer and writer owners remain real.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual,
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (faults.crossDevice || String(args[1]) === faults.publishPath) {
        const code = faults.crossDevice ? 'EXDEV' : 'EPERM';
        faults.crossDevice = false;
        throw Object.assign(new Error(code), { code });
      }
      return actual.rename(...args);
    }),
    copyFile: vi.fn(async (...args: Parameters<typeof actual.copyFile>) => {
      if (faults.raceCopy) { faults.raceCopy = false; await actual.writeFile(args[1], 'raced-destination'); }
      return actual.copyFile(...args);
    }),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]) === faults.cleanupPath) {
        faults.cleanupPath = '';
        throw Object.assign(new Error('staged source in use'), { code: 'EPERM' });
      }
      return actual.rm(...args);
    }),
  };
});

import { finalizeWorkspaceFileUpload } from './finalizeWorkspaceFileUpload';
const payload = Buffer.from('payload');
const sha256 = createHash('sha256').update(payload).digest('hex');
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-finalize-upload-'));
  roots.push(root);
  const tempPath = join(root, 'upload');
  const destPath = join(root, 'dest', 'file.txt');
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(tempPath, payload);
  return { root, tempPath, destPath, destDisplayPath: 'dest/file.txt', overwrite: true, sizeBytes: payload.length, sha256 };
}
afterEach(async () => {
  Object.assign(faults, { crossDevice: false, cleanupPath: '', publishPath: '', raceCopy: false });
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('finalizeWorkspaceFileUpload', () => {
  it('crosses devices only into a temporary sibling and atomically publishes without moving the destination aside', async () => {
    const input = await fixture();
    await writeFile(input.destPath, 'original');
    faults.crossDevice = true;
    expect(await finalizeWorkspaceFileUpload(input)).toEqual({ success: true, path: input.destDisplayPath, sizeBytes: payload.length });
    expect(await readFile(input.destPath)).toEqual(payload);
    expect(vi.mocked(renameMock).mock.calls.some(([from]) => from === input.destPath)).toBe(false);
    expect(vi.mocked(copyFileMock).mock.calls.every(([, to]) => to !== input.destPath)).toBe(true);
    expect(await readdir(dirname(input.destPath))).toEqual(['file.txt']);
  });

  it('leaves the destination intact and retains the source when cross-device staging cleanup fails', async () => {
    const input = await fixture();
    await writeFile(input.destPath, 'original');
    faults.crossDevice = true;
    faults.cleanupPath = input.tempPath;
    expect(await finalizeWorkspaceFileUpload(input)).toMatchObject({ success: false, errorCode: 'file_replace_failed', keepSession: true });
    expect(await readFile(input.destPath, 'utf8')).toBe('original');
    expect(await readFile(input.tempPath)).toEqual(payload);
    expect(await readdir(dirname(input.destPath))).toEqual(['file.txt']);
  });

  it('fails closed without a copy fallback when publication itself is denied', async () => {
    const input = await fixture();
    await writeFile(input.destPath, 'original');
    faults.publishPath = input.destPath;
    expect(await finalizeWorkspaceFileUpload(input)).toMatchObject({ success: false, errorCode: 'file_replace_failed', keepSession: false });
    expect(await readFile(input.destPath, 'utf8')).toBe('original');
    expect(copyFileMock).not.toHaveBeenCalled();
    expect(await readdir(dirname(input.destPath))).toEqual(['file.txt']);
  });

  it('keeps the real upload session when source cleanup prevents publication', async () => {
    const input = await fixture();
    await writeFile(input.destPath, 'original');
    const store = new TransferSessionStore({ ttlMs: 10_000, tempRoot: join(input.root, 'sessions') });
    const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 8 });
    try {
      const opened = await openUploadTransferSession({ lifecycle, target: {
        destPath: input.destPath, destDisplayPath: input.destDisplayPath, overwrite: true, expectedSizeBytes: payload.length,
        finalizeUpload: finalized => finalizeWorkspaceFileUpload({ ...input, ...finalized }),
      } });
      expect(await writeUploadTransferChunk({ lifecycle, uploadId: opened.uploadId, index: 0,
        contentBase64: payload.toString('base64') })).toEqual({ success: true });
      const stored = store.getUploadSession(opened.uploadId);
      if (!stored) throw new Error('Missing upload session');
      faults.crossDevice = true;
      faults.cleanupPath = stored.tempPath;
      expect(await finalizeUploadTransferSession({ lifecycle, uploadId: opened.uploadId }))
        .toMatchObject({ success: false, errorCode: 'file_replace_failed', keepSession: true });
      expect(store.getUploadSession(opened.uploadId)).toBe(stored);
      expect(await readFile(stored.tempPath)).toEqual(payload);
      expect(await readFile(input.destPath, 'utf8')).toBe('original');
    } finally { await store.dispose(); }
  });

  it('preserves exclusive creation for an unguarded no-overwrite upload', async () => {
    const input = await fixture();
    faults.raceCopy = true;
    expect(await finalizeWorkspaceFileUpload({ ...input, overwrite: false })).toMatchObject({ success: false, keepSession: true });
    expect(await readFile(input.destPath, 'utf8')).toBe('raced-destination');
    expect(await readFile(input.tempPath)).toEqual(payload);
    expect(renameMock).not.toHaveBeenCalled();
  });
});
