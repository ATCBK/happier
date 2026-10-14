import { describe, expect, it } from 'vitest';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { registerTransferUploadRpcHandlers } from './registerTransferUploadRpcHandlers';

describe('generic upload request admission', () => {
  it('refuses the retired asset tag without reinterpreting it as a workspace upload', async () => {
    const workingDirectory = await createTempDir('happier-retired-upload-');
    const store = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
    registerTransferUploadRpcHandlers(manager, { workingDirectory, store });
    try {
      const request = { path: 'retained.txt', sizeBytes: 0 };
      expect(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
        { ...request, t: 'prompt_asset_upload_v1' })).toMatchObject({ success: false });
      expect(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
        { ...request, t: 'session_file_upload_v1' })).toMatchObject({ success: true, uploadId: expect.any(String) });
      expect(await manager.invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request))
        .toMatchObject({ success: true, uploadId: expect.any(String) });
    } finally {
      await store.dispose();
      await removeTempDir(workingDirectory);
    }
  });
});
