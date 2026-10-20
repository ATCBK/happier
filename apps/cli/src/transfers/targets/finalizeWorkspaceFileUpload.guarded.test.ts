import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TransferSessionStore, createTransferSessionLifecycle, finalizeUploadTransferSession,
  openUploadTransferSession, writeUploadTransferChunk } from '@happier-dev/transfers/node';
import { resolveWorkspaceFileUploadTarget } from './resolveWorkspaceFileUploadTarget';
import { finalizeWorkspaceFileUpload } from './finalizeWorkspaceFileUpload';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-upload-guard-'));
  roots.push(root);
  return { root, destPath: join(root, 'file.txt'), tempPath: join(root, 'upload') };
}

describe('guarded upload finalization', () => {
  it('returns the typed conflict without replacing a changed destination', async () => {
    const { root, destPath, tempPath } = await fixture();
    await writeFile(destPath, 'agent wrote');
    await writeFile(tempPath, 'mine');
    expect(await finalizeWorkspaceFileUpload({ tempPath, destPath, destDisplayPath: 'file.txt',
      overwrite: true, sizeBytes: 4, expectedHash: sha256('old'), sha256: sha256('mine') }))
      .toMatchObject({ success: false, errorCode: 'hash_mismatch' });
    expect(await readFile(destPath, 'utf8')).toBe('agent wrote');
    expect((await readdir(root)).some(name => name.startsWith('.tmp-'))).toBe(false);
  });

  it('writes a multi-MB guarded upload through the real session and finalization target', async () => {
    const { root, destPath } = await fixture();
    await writeFile(destPath, 'before');
    const payload = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const store = new TransferSessionStore({ ttlMs: 10_000, tempRoot: join(root, 'sessions') });
    const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 256 * 1024 });
    try {
      const resolved = resolveWorkspaceFileUploadTarget({ workingDirectory: root, path: destPath,
        overwrite: true, sizeBytes: payload.length, expectedHash: sha256('before') });
      if (!resolved.success) throw new Error(resolved.error);
      const session = await openUploadTransferSession({ lifecycle, target: resolved.target });
      for (let offset = 0, index = 0; offset < payload.length; offset += session.chunkSizeBytes, index++) {
        expect(await writeUploadTransferChunk({ lifecycle, uploadId: session.uploadId, index,
          contentBase64: payload.subarray(offset, offset + session.chunkSizeBytes).toString('base64') })).toMatchObject({ success: true });
      }
      expect(await finalizeUploadTransferSession({ lifecycle, uploadId: session.uploadId })).toMatchObject({ success: true });
      expect(await readFile(destPath)).toEqual(payload);
    } finally {
      await store.dispose();
    }
  });
});
