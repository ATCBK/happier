import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { materializePluginSessionAttachment } from './materializePluginSessionAttachment';

describe('plugin Session attachment materialization', () => {
  it('delivers exact binary bytes through the real Session upload target and refuses an unhosted Session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-channel-attachment-'));
    const sourcePath = join(directory, 'provider.bin');
    const bytes = Buffer.from([0, 255, 1, 2, 0, 128]);
    const store = new TransferSessionStore({ ttlMs: 60_000 });
    const rpc = new RpcHandlerManager({ scopePrefix: 'test', encryptionMode: 'plain' });
    try {
      await writeFile(sourcePath, bytes);
      registerTransferUploadRpcHandlers(rpc, {
        workingDirectory: directory,
        store,
        attachmentUpload: { resolveSessionWorkingDirectory: async id => id === 'session-1' ? directory : null },
      });
      const request = { sourcePath, name: '../lead.bin', messageLocalId: 'input-1' };
      const result = await materializePluginSessionAttachment({ rpc, sessionId: 'session-1', request, signal: new AbortController().signal });
      expect(result.path).toContain('.happier/uploads/messages/input-1/');
      expect(result.path.endsWith('-lead.bin')).toBe(true);
      expect(await readFile(join(directory, result.path))).toEqual(bytes);
      expect(result.bytes).toEqual(bytes);
      await expect(materializePluginSessionAttachment({ rpc, sessionId: 'remote-session', request, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'plugin_session_attachment_unavailable' });
      const cancellation = new AbortController();
      cancellation.abort();
      await expect(materializePluginSessionAttachment({ rpc, sessionId: 'session-1', request, signal: cancellation.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await store.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
