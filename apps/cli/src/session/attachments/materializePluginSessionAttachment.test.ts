import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { materializePluginSessionAttachment } from './materializePluginSessionAttachment';
import { ApiMachineClient } from '@/api/apiMachine';
import { createDaemonPluginTransferRpcResolver } from '@/plugins/daemon/runtimeOwner';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

describe('plugin Session attachment materialization', () => {
  it('uses the daemon host carrier without a peer grant and preserves the hosted Session destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-host-attachment-'));
    const sourcePath = join(directory, 'lead.pdf');
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const machine = new ApiMachineClient('fixture-token', {
      id: 'attachment-machine', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    }, undefined, { resolveHostedSessionWorkingDirectory: async id => id === 'session-1' ? directory : null });
    let activeMachine: ApiMachineClient | null = null;
    const resolveRpc = createDaemonPluginTransferRpcResolver(() => activeMachine);
    try {
      await writeFile(sourcePath, bytes);
      expect(resolveRpc()).toBeNull();
      activeMachine = machine;
      const rpc = resolveRpc();
      if (!rpc) throw new Error('Expected daemon transfer carrier');
      const request = { sourcePath, name: 'lead.pdf', messageLocalId: 'input-1' };
      const result = await materializePluginSessionAttachment({ rpc, sessionId: 'session-1', request, signal: new AbortController().signal });
      expect(await readFile(join(directory, result.path))).toEqual(bytes);
      expect(result.bytes).toEqual(bytes);
      await expect(materializePluginSessionAttachment({ rpc, sessionId: 'foreign-session', request, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'plugin_session_attachment_unavailable' });
      await expect(machine.getPeerMediationMachineRpcHandlerManager().invokeLocal(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
        t: 'session_attachment_upload_v1', sessionId: 'session-1', messageLocalId: 'input-1', fileName: 'lead.pdf', sizeBytes: bytes.byteLength,
      })).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally {
      await machine.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
