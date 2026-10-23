import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { configuration } from '@/configuration';
import { admitSessionStructuredInputV1 } from '@/session/services/admitSessionStructuredInputV1';
import { materializeSessionAttachments } from './materializeSessionAttachments';

describe('external bytes through target Session issuance', () => {
  it.each([{ name: 'pixel.png', empty: false }, { name: 'diagram', empty: true }])(
    'materializes $name as native image input and the full folder tree (empty=$empty)', async ({ name, empty }) => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-discussion-target-'));
    const store = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
    // External RPC publication is unnecessary for an in-process upload; the returned
    // invoker retains the real lifecycle, encrypted chunks, target and issuance.
    const rpc = registerTransferUploadRpcHandlers({ registerHandler: () => {} }, {
      workingDirectory: workspace, store, sessionAttachment: { sessionId: 'session-1' },
      attachmentUpload: { resolveSessionWorkingDirectory: async sessionId => sessionId === 'session-1' ? workspace : null },
    });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
    const note = Buffer.from('committed Discussion bytes');
    const acquired: string[] = [];
    try {
      const projected = await materializeSessionAttachments({
        sessionId: 'session-1', messageLocalId: 'original-input', rpc,
        resolveSessionAttachment: handle => store.getIssuedAttachment(handle),
        signal: new AbortController().signal,
        attachments: [
          { kind: 'file', id: 'image', name, file: { id: 'pixel', bytes: png } },
          { kind: 'file', id: 'note', name: 'notes.txt', file: { id: 'note', bytes: note } },
          { kind: 'folder', id: 'folder', name: 'project', directories: ['empty', 'nested/empty'],
            entries: empty ? [] : [{ relativePath: 'nested/notes.txt', file: { id: 'leaf', bytes: note } }] },
        ],
        readFile: async file => { acquired.push(file.id); return file.bytes; },
      });
      const admitted = admitSessionStructuredInputV1({ ...projected,
        admissionPolicy: { allowedLocalImagePaths: projected.allowedLocalImagePaths } });
      expect(acquired).toEqual(empty ? ['pixel', 'note'] : ['pixel', 'note', 'leaf']);
      const attachments = projected.meta.happier as { payload: { attachments: { id: string; path: string; attachmentHandle: unknown; mimeType: string }[] } };
      expect(attachments.payload.attachments).toHaveLength(3);
      for (const attachment of attachments.payload.attachments) {
        expect(attachment.attachmentHandle).toMatchObject({ v: 1, sessionId: 'session-1' });
      }
      const image = attachments.payload.attachments.find(file => file.id === 'image')!;
      const generic = attachments.payload.attachments.find(file => file.id === 'note')!;
      const folder = attachments.payload.attachments.find(file => file.id === 'folder')!;
      expect(await readFile(join(workspace, image.path))).toEqual(png);
      expect(await readFile(join(workspace, generic.path))).toEqual(note);
      expect(folder.mimeType).toBe('inode/directory');
      expect((await stat(join(workspace, folder.path, 'empty'))).isDirectory()).toBe(true);
      expect((await stat(join(workspace, folder.path, 'nested/empty'))).isDirectory()).toBe(true);
      if (!empty) expect(await readFile(join(workspace, folder.path, 'nested/notes.txt'))).toEqual(note);
      expect(admitted.structuredInput).toMatchObject({ imageInputs: [{ path: image.path, mimeType: 'image/png' }] });
    } finally {
      await store.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
