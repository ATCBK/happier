import { describe, expect, it } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from './rpcHandlers';

describe('source-composed machine Found transfer registration', () => {
  it('retains the download transport and refuses every retired asset operation through production registration', async () => {
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    const registration = registerMachineRpcHandlers({ rpcHandlerManager: manager, handlers: {
      spawnSession: async () => ({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Unavailable fixture Agent' }),
      stopSession: async () => true, requestShutdown: () => {},
    } });
    try {
      for (const method of ['daemon.promptAssets.discover', 'daemon.promptAssets.delete', 'daemon.promptAssets.listTypes',
        'daemon.promptAssets.upload.init', 'daemon.promptAssets.upload.chunk', 'daemon.promptAssets.upload.finalize', 'daemon.promptAssets.upload.abort']) {
        expect(await manager.invokeLocal(method, {})).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
      }
      expect(await manager.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, {}))
        .toMatchObject({ success: false });
      for (const method of [RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
        RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT]) {
        expect(await manager.invokeLocal(method, {})).not.toHaveProperty('errorCode', RPC_ERROR_CODES.METHOD_NOT_FOUND);
      }
    } finally {
      await registration.dispose();
    }
  });
});
